#!/usr/bin/env python3
"""Telegram bot for the keep: alerts with buttons, commands, charts and an AI that can look at the whole box.

Runs on the host as root (keep-bot.service), outside Docker, so it keeps working when Docker, Traefik, Tailscale or
DDNS break: it only needs outbound internet, and resolves through DNS-over-HTTPS when the local resolver is down.

  /etc/keep/bot.env           TELEGRAM_TOKEN, TELEGRAM_CHAT (a forum group), TELEGRAM_OWNER (the only user it obeys),
                              BOT_PIN (for shell commands), GROQ_API_KEY, HC_PING_KEY, optional TZ, DDNS_HOST,
                              DIGEST_AT (HH:MM local), AI_DAILY_TOKENS, KUMA_PUBLIC_URL
  /var/lib/keep-bot/          topics.json (topic name -> thread id, created on first start), state.json
  <KEEP_DATA>/outbox/*.json   messages other scripts and the dashboard hand over, see handle_outbox()

Nothing that changes the box runs without a tap from the owner, except the network watchdog and restarting a crashed
container once. Shell commands also need the PIN, entered on a button keypad so it never sits in the chat.
"""

import hmac
import http.client
import json
import os
import re
import shlex
import shutil
import socket
import sqlite3
import struct
import subprocess
import sys
import threading
import time
import traceback
import urllib.parse
import uuid
import zlib
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

ENV_FILE = "/etc/keep/bot.env"
STATE_DIR = "/var/lib/keep-bot"
DATA = os.environ.get("KEEP_DATA", "/srv/keep-dashboard")
OUTBOX = f"{DATA}/outbox"
HISTORY_DB = f"{DATA}/history.db"
NTFY_ENV = "/srv/uptime-kuma/admin.env"
KUMA_KEY = "/srv/uptime-kuma/metrics.key"
MODEL = "openai/gpt-oss-120b"
UA = "keep-bot/1"

TOPICS = {
    "alerts": ("🚨 alerts", 0xFB6F5F, "things broken right now. each alert edits itself when it recovers."),
    "control": ("💬 control", 0x6FB9F0, "talk to the keep here. commands or plain language."),
    "actions": ("🧾 actions", 0x8EEE98, "log of everything done: buttons, commands, ai and automatic fixes."),
    "jobs": ("⚙️ jobs", 0xFFD67E, "scheduled job runs and results."),
    "deploys": ("🚀 deploys", 0xCB86DB, "dokploy deploys and pr previews."),
    "updates": ("🔄 updates", 0x6FB9F0, "apt, reboots, image versions."),
    "access": ("🛡 access", 0xFF93B2, "ssh, sudo, devices, logins."),
    "mail": ("✉️ mail", 0xFFD67E, "reply drafts to approve."),
    "digest": ("☀️ digest", 0x8EEE98, "morning summary."),
}
TOPIC_CONTEXT = {
    "alerts": "the alerts topic: questions are usually about something that is broken right now",
    "control": "the control topic: anything about the box",
    "actions": "the actions log topic: questions are usually about what was done and by whom",
    "jobs": "the jobs topic: scheduled keep-* systemd jobs and their runs",
    "deploys": "the deploys topic: Dokploy apps, deployments and PR previews",
    "updates": "the updates topic: apt upgrades, reboots and image versions",
    "access": "the access topic: SSH logins, sudo, tailnet devices",
    "mail": "the mail topic: the n8n mail workflows and reply drafts",
    "digest": "the digest topic: the daily summary and trends",
}


def load_env():
    env = {}
    try:
        for line in open(ENV_FILE):
            if "=" in line and not line.lstrip().startswith("#"):
                key, value = line.split("=", 1)
                env[key.strip()] = value.strip().strip('"').strip("'")
    except OSError:
        pass
    return env


ENV = load_env()
TOKEN = ENV.get("TELEGRAM_TOKEN", "")
CHAT = int(ENV.get("TELEGRAM_CHAT", "0") or 0)
OWNER = int(ENV.get("TELEGRAM_OWNER", "0") or 0)
PIN = ENV.get("BOT_PIN", "")
TZ = ZoneInfo(ENV.get("TZ", "UTC"))
LOCK = threading.RLock()
STATE = {}
TOPIC_IDS = {}
BOT_NAME = ""


def log(*parts):
    print(datetime.now().strftime("%H:%M:%S"), *parts, flush=True)


def load_state():
    global STATE
    try:
        STATE = json.load(open(f"{STATE_DIR}/state.json"))
    except (OSError, ValueError):
        STATE = {}
    for key in ("messages", "actions", "mutes", "seen"):
        STATE.setdefault(key, {})


def save_state():
    with LOCK:
        week = time.time() - 7 * 86400
        STATE["actions"] = {k: v for k, v in STATE["actions"].items() if v.get("at", 0) > week}
        STATE["messages"] = {k: v for k, v in STATE["messages"].items() if v.get("at", 0) > time.time() - 30 * 86400}
        STATE["mutes"] = {k: v for k, v in STATE["mutes"].items() if v > time.time()}
        os.makedirs(STATE_DIR, mode=0o700, exist_ok=True)
        with open(f"{STATE_DIR}/state.json.tmp", "w") as handle:
            json.dump(STATE, handle)
        os.replace(f"{STATE_DIR}/state.json.tmp", f"{STATE_DIR}/state.json")


# ---------------------------------------------------------------- network: HTTPS that survives a dead local resolver

IP_CACHE = {}


def resolve(host):
    try:
        ip = socket.getaddrinfo(host, 443, socket.AF_INET, socket.SOCK_STREAM)[0][4][0]
        IP_CACHE[host] = ip
        return ip
    except OSError:
        pass
    try:  # DNS-over-HTTPS straight to Cloudflare, for when AdGuard or systemd-resolved is down
        conn = http.client.HTTPSConnection("1.1.1.1", timeout=8)
        conn.request("GET", f"/dns-query?name={host}&type=A", headers={"accept": "application/dns-json"})
        answers = [a["data"] for a in json.load(conn.getresponse()).get("Answer", []) if a.get("type") == 1]
        if answers:
            IP_CACHE[host] = answers[0]
            return answers[0]
    except (OSError, ValueError):
        pass
    if host in IP_CACHE:
        return IP_CACHE[host]
    raise OSError(f"cannot resolve {host}")


class PinnedConnection(http.client.HTTPSConnection):
    def __init__(self, host, ip, timeout):
        super().__init__(host, timeout=timeout)
        self.ip = ip

    def connect(self):
        sock = socket.create_connection((self.ip, 443), self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


def https(method, url, body=None, headers=None, timeout=40):
    parts = urllib.parse.urlsplit(url)
    conn = PinnedConnection(parts.hostname, resolve(parts.hostname), timeout)
    try:
        path = parts.path + (f"?{parts.query}" if parts.query else "")
        conn.request(method, path, body=body, headers={"User-Agent": UA, **(headers or {})})
        response = conn.getresponse()
        return response.status, response.read()
    finally:
        conn.close()


def online():
    for host, port in (("1.1.1.1", 443), ("8.8.8.8", 53), ("9.9.9.9", 443)):
        try:
            socket.create_connection((host, port), 3).close()
            return True
        except OSError:
            continue
    return False


# ---------------------------------------------------------------- telegram


class TgError(Exception):
    pass


def multipart(params, files, boundary):
    out = []
    for key, value in params.items():
        value = value if isinstance(value, str) else json.dumps(value)
        out.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode())
    for key, (name, data, mime) in files.items():
        out.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"; filename="{name}"\r\n'
                   f"Content-Type: {mime}\r\n\r\n".encode() + data + b"\r\n")
    out.append(f"--{boundary}--\r\n".encode())
    return b"".join(out)


def tg(method, files=None, **params):
    params = {k: v for k, v in params.items() if v is not None}
    if files:
        boundary = uuid.uuid4().hex
        body, headers = multipart(params, files, boundary), {"Content-Type": f"multipart/form-data; boundary={boundary}"}
    else:
        body, headers = json.dumps(params).encode(), {"Content-Type": "application/json"}
    status, raw = https("POST", f"https://api.telegram.org/bot{TOKEN}/{method}", body, headers,
                        params.get("timeout", 0) + 30)
    data = json.loads(raw or b"{}")
    if not data.get("ok"):
        retry = (data.get("parameters") or {}).get("retry_after")
        if retry and retry <= 60:
            time.sleep(retry)
            return tg(method, files, **params)
        raise TgError(data.get("description", f"http {status}"))
    return data["result"]


def ensure_topics():
    path = f"{STATE_DIR}/topics.json"
    try:
        TOPIC_IDS.update(json.load(open(path)))
    except (OSError, ValueError):
        pass
    for key, (name, color, intro) in TOPICS.items():
        if key in TOPIC_IDS:
            continue
        thread = tg("createForumTopic", chat_id=CHAT, name=name, icon_color=color)["message_thread_id"]
        TOPIC_IDS[key] = thread
        tg("sendMessage", chat_id=CHAT, message_thread_id=thread, text=intro, disable_notification=True)
    os.makedirs(STATE_DIR, mode=0o700, exist_ok=True)
    json.dump(TOPIC_IDS, open(path, "w"), indent=1)


def topic_of(thread):
    return next((k for k, v in TOPIC_IDS.items() if v == thread), "control")


def html_escape(text):
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def md_to_html(text):
    """The AI writes light markdown; Telegram wants HTML."""
    text = html_escape(text)
    text = re.sub(r"```(?:\w+)?\n?(.*?)```", lambda m: f"<pre>{m.group(1).strip()}</pre>", text, flags=re.S)
    text = re.sub(r"`([^`\n]+)`", r"<code>\1</code>", text)
    text = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", text)
    text = re.sub(r"(?m)^#{1,6}\s*(.+)$", r"<b>\1</b>", text)
    return text


def register(action):
    aid = uuid.uuid4().hex[:10]
    with LOCK:
        STATE["actions"][aid] = {**action, "at": time.time()}
    save_state()
    return aid


def keyboard(rows):
    """rows: [[(label, action-dict | "url:..."), ...], ...]"""
    out = []
    for row in rows:
        line = []
        for label, action in row:
            if isinstance(action, str) and action.startswith("url:"):
                line.append({"text": label, "url": action[4:]})
            elif isinstance(action, str):
                line.append({"text": label, "callback_data": action})
            else:
                line.append({"text": label, "callback_data": f"a:{register(action)}"})
        out.append(line)
    return {"inline_keyboard": out}


def send(topic, text, *, buttons=None, key=None, silent=None, photo=None, document=None, html=False, reply_to=None,
         markup=None):
    """Post to a topic (name or thread id). With `key`, a later send with the same key edits that message instead."""
    thread = TOPIC_IDS.get(topic, TOPIC_IDS.get("control")) if isinstance(topic, str) else topic
    if silent is None:
        silent = topic != "alerts"
    if key and STATE["mutes"].get(key, 0) > time.time():
        silent = True
    markup = markup or (keyboard(buttons) if buttons else None)
    parse = "HTML" if html else None
    if not photo and not document and len(text) > 4000:
        document = ("output.txt", text.encode())
        text = text.split("\n", 1)[0][:200] + " (full text attached)"
    with LOCK:
        old = STATE["messages"].get(key) if key else None
    if old:
        try:
            edit = dict(chat_id=CHAT, message_id=old["id"], parse_mode=parse,
                        reply_markup=markup or {"inline_keyboard": []})
            if old.get("media"):
                tg("editMessageCaption", caption=text[:1024], **edit)
            else:
                tg("editMessageText", text=text[:4096], link_preview_options={"is_disabled": True}, **edit)
            return old["id"]
        except TgError as error:
            if "not modified" in str(error):
                return old["id"]
            log("edit failed, sending new:", error)
    common = dict(chat_id=CHAT, message_thread_id=thread, disable_notification=silent, parse_mode=parse,
                  reply_markup=markup)
    if reply_to:
        common["reply_parameters"] = {"message_id": reply_to, "allow_sending_without_reply": True}
    try:
        if photo:
            message = tg("sendPhoto", files={"photo": ("chart.png", photo, "image/png")}, caption=text[:1024], **common)
        elif document:
            name, data = document
            message = tg("sendDocument", files={"document": (name, data, "text/plain")}, caption=text[:1024], **common)
        else:
            message = tg("sendMessage", text=text[:4096] or "…", link_preview_options={"is_disabled": True}, **common)
    except TgError as error:
        if html and "parse" in str(error).lower():
            return send(topic, re.sub(r"<[^>]+>", "", text), buttons=None, key=key, silent=silent, photo=photo,
                        document=document, reply_to=reply_to, markup=markup)
        raise
    if key:
        with LOCK:
            STATE["messages"][key] = {"id": message["message_id"], "media": bool(photo or document), "at": time.time()}
        save_state()
    return message["message_id"]


def safe_send(*args, **kwargs):
    try:
        return send(*args, **kwargs)
    except Exception as error:  # noqa: BLE001 - a failed post must never kill a watcher
        log("send failed:", error)
        return None


def log_action(text):
    safe_send("actions", text)


# ---------------------------------------------------------------- shell helpers


def run(cmd, timeout=30, input_text=None):
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, input=input_text,
                                shell=isinstance(cmd, str))
        return result.returncode, (result.stdout + result.stderr).strip()
    except subprocess.TimeoutExpired:
        return 124, f"timed out after {timeout}s"
    except OSError as error:
        return 127, str(error)


def clip(text, limit=7000):
    return text if len(text) <= limit else text[: limit // 3] + f"\n… [{len(text) - limit} chars cut] …\n" + text[-2 * limit // 3:]


def human_bytes(n):
    n = float(n or 0)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(n) < 1000 or unit == "TB":
            return f"{n:.0f} {unit}" if unit in ("B", "KB") else f"{n:.1f} {unit}"
        n /= 1000
    return f"{n:.1f} TB"


def parse_size(text):
    match = re.match(r"([\d.]+)\s*([kKMGT]?B)", text or "")
    if not match:
        return 0
    return float(match.group(1)) * {"B": 1, "kB": 1e3, "KB": 1e3, "MB": 1e6, "GB": 1e9, "TB": 1e12}[match.group(2)]


def ago(ts):
    seconds = max(0, time.time() - ts)
    for size, unit in ((86400, "d"), (3600, "h"), (60, "m")):
        if seconds >= size:
            return f"{int(seconds // size)}{unit}"
    return f"{int(seconds)}s"


def local(ts, fmt="%H:%M"):
    return datetime.fromtimestamp(ts, TZ).strftime(fmt)


def span(text, default="1h"):
    """'90m', '2h', '3d' -> seconds"""
    match = re.fullmatch(r"(\d+)\s*(s|m|min|h|d|w)?", (text or default).strip().lower())
    if not match:
        return span(default)
    return int(match.group(1)) * {"s": 1, "m": 60, "min": 60, "h": 3600, "d": 86400, "w": 604800}[match.group(2) or "h"]


# ---------------------------------------------------------------- box facts (used by commands, watchers and the AI)


def containers():
    code, out = run(["docker", "ps", "-a", "--no-trunc", "--format", "{{json .}}"], 30)
    rows = []
    for line in out.splitlines() if code == 0 else []:
        try:
            row = json.loads(line)
        except ValueError:
            continue
        labels = dict(part.split("=", 1) for part in row.get("Labels", "").split(",") if "=" in part)
        exit_code = re.search(r"Exited \((\d+)\)", row.get("Status", ""))
        rows.append({"name": row["Names"], "state": row["State"], "status": row["Status"], "image": row["Image"],
                     "service": labels.get("com.docker.swarm.service.name") or labels.get("com.docker.compose.service"),
                     "swarm": labels.get("com.docker.swarm.service.name"),
                     "project": labels.get("com.docker.compose.project"),
                     "exit": int(exit_code.group(1)) if exit_code else None,
                     "unhealthy": "(unhealthy)" in row.get("Status", "")})
    return rows


def find_container(query):
    rows = containers()
    names = [r["name"] for r in rows]
    if query in names:
        return next(r for r in rows if r["name"] == query), None
    matches = [r for r in rows if query.lower() in r["name"].lower() or query.lower() == (r["service"] or "").lower()]
    running = [r for r in matches if r["state"] == "running"]
    if len(matches) == 1 or len(running) == 1:
        return (matches if len(matches) == 1 else running)[0], None
    if not matches:
        return None, f"no container matches '{query}'"
    return None, "several containers match: " + ", ".join(r["name"] for r in matches[:15])


def mounts():
    seen, out = set(), []
    for line in open("/proc/mounts"):
        device, path, fstype = line.split()[:3]
        if not device.startswith("/dev/") or fstype in ("squashfs", "vfat", "iso9660") or device in seen:
            continue
        if path.startswith(("/boot", "/snap", "/var/lib/docker", "/run")):
            continue
        seen.add(device)
        usage = shutil.disk_usage(path)
        out.append((path, usage.used, usage.total))
    return out


def history(key, seconds, points=400):
    bucket = max(60, seconds // points // 60 * 60)
    try:
        db = sqlite3.connect(f"file:{HISTORY_DB}?mode=ro", uri=True, timeout=5)
        rows = db.execute("SELECT ts / ? * ? AS b, avg(avg), max(max) FROM points WHERE key = ? AND ts >= ? "
                          "GROUP BY b ORDER BY b", (bucket, bucket, key, int(time.time()) - seconds)).fetchall()
        db.close()
        return rows
    except sqlite3.Error:
        return []


def history_keys():
    try:
        db = sqlite3.connect(f"file:{HISTORY_DB}?mode=ro", uri=True, timeout=5)
        keys = [r[0] for r in db.execute("SELECT DISTINCT key FROM points WHERE ts >= ?", (int(time.time()) - 3600,))]
        db.close()
        return keys
    except sqlite3.Error:
        return []


def latest(key):
    rows = history(key, 600)
    return rows[-1][1] if rows else None


def default_iface():
    code, out = run(["ip", "route", "show", "default"])
    match = re.search(r"dev (\S+)", out)
    gateway = re.search(r"via (\S+)", out)
    return (match.group(1) if match else None), (gateway.group(1) if gateway else None)


def read_json(path, default=None):
    try:
        return json.load(open(path))
    except (OSError, ValueError):
        return default


def jobs():
    return (read_json(f"{DATA}/jobs.json", {}) or {}).get("jobs", [])


def kuma_container():
    return next((r["name"] for r in containers() if "uptime-kuma" in r["name"] and r["state"] == "running"), None)


def kuma_monitors():
    """{id: {name, url, status (1 up, 0 down, 2 pending, 3 maintenance), ms}} straight from Kuma's metrics."""
    name = kuma_container()
    try:
        key = open(KUMA_KEY).read().strip()
    except OSError:
        return None
    if not name or not key:
        return None
    code, out = run(["docker", "exec", "-e", f"K={key}", name, "sh", "-c",
                     'curl -s -m 8 -u ":$K" http://127.0.0.1:3001/metrics'], 20)
    if code != 0 or "monitor_status" not in out:
        return None
    monitors = {}
    for line in out.splitlines():
        match = re.match(r"^(monitor_status|monitor_response_time)\{([^}]*)\}\s+(\S+)$", line)
        if not match:
            continue
        labels = dict(re.findall(r'(\w+)="((?:[^"\\]|\\.)*)"', match.group(2)))
        mid = labels.get("monitor_id") or labels.get("monitor_name")
        monitor = monitors.setdefault(mid, {"name": labels.get("monitor_name"), "status": None, "ms": None,
                                            "url": labels.get("monitor_url") or labels.get("monitor_hostname") or ""})
        value = float(match.group(3))
        if match.group(1) == "monitor_status":
            monitor["status"] = int(value)
        else:
            monitor["ms"] = value
    return monitors


def n8n_db():
    override = ENV.get("N8N_DB_CONTAINER")
    if override:
        return override
    names = [r["name"] for r in containers() if r["state"] == "running"]
    app = next((n for n in names if re.search(r"-n8n-\d+$", n)), None)
    return app and next((n for n in names if n == re.sub(r"-n8n-(\d+)$", r"-db-\1", app)), None)


def n8n_query(sql):
    db = n8n_db()
    if not db:
        raise RuntimeError("n8n database container not found")
    code, out = run(["docker", "exec", "-i", db, "sh", "-c",
                     'psql -X -qAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'], 60,
                    f"BEGIN READ ONLY;\n{sql};\nCOMMIT;\n")
    if code != 0:
        raise RuntimeError(clip(out, 500))
    return json.loads(out.strip() or "null")


def sql_text(value):
    return "'" + str(value).replace("'", "''") + "'"


def unflatten(text):
    """n8n stores execution data in the `flatted` format: one array, objects point at other entries by index."""
    items = json.loads(text)
    memo = {}

    def revive(index):
        if index in memo:
            return memo[index]
        value = items[index]
        if isinstance(value, list):
            memo[index] = out = []
            out.extend(resolve_ref(x) for x in value)
            return out
        if isinstance(value, dict):
            memo[index] = out = {}
            for k, x in value.items():
                out[k] = resolve_ref(x)
            return out
        return value

    def resolve_ref(value):
        return revive(int(value)) if isinstance(value, str) and value.isdigit() else value

    return revive(0)


# ---------------------------------------------------------------- charts: a tiny PNG line chart, stdlib only

BG, FG, MUTED, DIM, GRID, ORANGE, RED = ((0x18, 0x17, 0x15), (0xff, 0xf7, 0xf0), (0xaa, 0xa3, 0x9b),
                                         (0x4a, 0x46, 0x41), (0x2e, 0x2c, 0x29), (0xd5, 0x9b, 0x60), (0xe0, 0x5a, 0x4a))
FONT = {  # 5x7, one byte per column, bit 0 = top row
    " ": (0, 0, 0, 0, 0), "0": (0x3E, 0x51, 0x49, 0x45, 0x3E), "1": (0x00, 0x42, 0x7F, 0x40, 0x00),
    "2": (0x42, 0x61, 0x51, 0x49, 0x46), "3": (0x21, 0x41, 0x45, 0x4B, 0x31), "4": (0x18, 0x14, 0x12, 0x7F, 0x10),
    "5": (0x27, 0x45, 0x45, 0x45, 0x39), "6": (0x3C, 0x4A, 0x49, 0x49, 0x30), "7": (0x01, 0x71, 0x09, 0x05, 0x03),
    "8": (0x36, 0x49, 0x49, 0x49, 0x36), "9": (0x06, 0x49, 0x49, 0x29, 0x1E), "a": (0x20, 0x54, 0x54, 0x54, 0x78),
    "b": (0x7F, 0x48, 0x44, 0x44, 0x38), "c": (0x38, 0x44, 0x44, 0x44, 0x20), "d": (0x38, 0x44, 0x44, 0x48, 0x7F),
    "e": (0x38, 0x54, 0x54, 0x54, 0x18), "f": (0x08, 0x7E, 0x09, 0x01, 0x02), "g": (0x0C, 0x52, 0x52, 0x52, 0x3E),
    "h": (0x7F, 0x08, 0x04, 0x04, 0x78), "i": (0x00, 0x44, 0x7D, 0x40, 0x00), "j": (0x20, 0x40, 0x44, 0x3D, 0x00),
    "k": (0x7F, 0x10, 0x28, 0x44, 0x00), "l": (0x00, 0x41, 0x7F, 0x40, 0x00), "m": (0x7C, 0x04, 0x18, 0x04, 0x78),
    "n": (0x7C, 0x08, 0x04, 0x04, 0x78), "o": (0x38, 0x44, 0x44, 0x44, 0x38), "p": (0x7C, 0x14, 0x14, 0x14, 0x08),
    "q": (0x08, 0x14, 0x14, 0x18, 0x7C), "r": (0x7C, 0x08, 0x04, 0x04, 0x08), "s": (0x48, 0x54, 0x54, 0x54, 0x20),
    "t": (0x04, 0x3F, 0x44, 0x40, 0x20), "u": (0x3C, 0x40, 0x40, 0x20, 0x7C), "v": (0x1C, 0x20, 0x40, 0x20, 0x1C),
    "w": (0x3C, 0x40, 0x30, 0x40, 0x3C), "x": (0x44, 0x28, 0x10, 0x28, 0x44), "y": (0x0C, 0x50, 0x50, 0x50, 0x3C),
    "z": (0x44, 0x64, 0x54, 0x4C, 0x44), "%": (0x23, 0x13, 0x08, 0x64, 0x62), ".": (0x00, 0x60, 0x60, 0x00, 0x00),
    ":": (0x00, 0x36, 0x36, 0x00, 0x00), "-": (0x08, 0x08, 0x08, 0x08, 0x08), "/": (0x20, 0x10, 0x08, 0x04, 0x02),
    "(": (0x00, 0x1C, 0x22, 0x41, 0x00), ")": (0x00, 0x41, 0x22, 0x1C, 0x00), "+": (0x08, 0x08, 0x3E, 0x08, 0x08),
    "_": (0x40, 0x40, 0x40, 0x40, 0x40), ",": (0x00, 0x50, 0x30, 0x00, 0x00), "°": (0x00, 0x06, 0x09, 0x09, 0x06),
    "·": (0x00, 0x00, 0x08, 0x00, 0x00),
}


class Canvas:
    def __init__(self, width, height):
        self.w, self.h = width, height
        self.buf = bytearray(bytes(BG) * width * height)

    def px(self, x, y, color):
        if 0 <= x < self.w and 0 <= y < self.h:
            i = (y * self.w + x) * 3
            self.buf[i:i + 3] = bytes(color)

    def rect(self, x0, y0, x1, y1, color):
        for y in range(max(0, y0), min(self.h, y1)):
            i = (y * self.w + max(0, x0)) * 3
            self.buf[i:i + (min(self.w, x1) - max(0, x0)) * 3] = bytes(color) * (min(self.w, x1) - max(0, x0))

    def line(self, x0, y0, x1, y1, color, thick=2):
        dx, dy = abs(x1 - x0), -abs(y1 - y0)
        sx, sy = (1 if x0 < x1 else -1), (1 if y0 < y1 else -1)
        err = dx + dy
        while True:
            self.rect(x0, y0, x0 + thick, y0 + thick, color)
            if x0 == x1 and y0 == y1:
                return
            e2 = 2 * err
            if e2 >= dy:
                err += dy
                x0 += sx
            if e2 <= dx:
                err += dx
                y0 += sy

    def text(self, x, y, text, color, scale=2):
        for ch in text.lower():
            for cx, col in enumerate(FONT.get(ch, FONT[" "])):
                for cy in range(7):
                    if col >> cy & 1:
                        self.rect(x + cx * scale, y + cy * scale, x + (cx + 1) * scale, y + (cy + 1) * scale, color)
            x += 6 * scale
        return x

    def png(self):
        raw = b"".join(b"\x00" + bytes(self.buf[y * self.w * 3:(y + 1) * self.w * 3]) for y in range(self.h))

        def chunk(kind, data):
            return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)

        return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", self.w, self.h, 8, 2, 0, 0, 0))
                + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))


def metric_kind(key):
    if key in ("cpu", "mem"):
        return "pct"
    if key.startswith("temp:"):
        return "temp"
    if key.startswith(("net:", "disk:")):
        return "rate"
    if key.startswith(("vol:", "bucket:")):
        return "bytes"
    if key.endswith(":ms"):
        return "ms"
    return "num"


def fmt_value(value, kind):
    if value is None:
        return "-"
    return {"pct": lambda v: f"{v * 100:.0f}%", "temp": lambda v: f"{v:.0f}°c", "rate": lambda v: human_bytes(v) + "/s",
            "bytes": human_bytes, "ms": lambda v: f"{v:.0f} ms"}.get(kind, lambda v: f"{v:.0f}")(value)


def render_chart(title, series, seconds):
    """series: [(label, key)]. Returns (png, summary text) or (None, reason)."""
    data = [(label, key, history(key, seconds)) for label, key in series]
    data = [d for d in data if d[2]]
    if not data:
        return None, "no data for that range"
    kind = metric_kind(data[0][1])
    width, height, left, right, top, bottom = 1000, 520, 110, 30, 96, 56
    canvas = Canvas(width, height)
    end = int(time.time())
    start = end - seconds
    peak = max(row[1] for _, _, rows in data for row in rows)
    low = min(row[1] for _, _, rows in data for row in rows)
    ymax = 1.0 if kind == "pct" else (peak * 1.15 or 1)
    ymin = 0 if kind != "temp" else max(0, low - 10)
    plot_w, plot_h = width - left - right, height - top - bottom

    def xy(ts, value):
        x = left + int((ts - start) / max(1, seconds) * plot_w)
        y = top + plot_h - int((value - ymin) / max(1e-9, ymax - ymin) * plot_h)
        return x, max(top, min(top + plot_h, y))

    for i in range(5):
        y = top + plot_h * i // 4
        for x in range(left, width - right, 6):
            canvas.rect(x, y, x + 2, y + 1, GRID)
        canvas.text(8, y - 7, fmt_value(ymax - (ymax - ymin) * i / 4, kind), MUTED)
    colors = [FG, ORANGE, MUTED, RED]
    for index, (label, key, rows) in enumerate(data):
        points = [xy(ts, value) for ts, value, _ in rows]
        if index == 0:  # dithered area under the first series
            for (x0, y0), (x1, _) in zip(points, points[1:] + points[-1:]):
                for x in range(x0, max(x0 + 1, x1)):
                    for y in range(y0 + 3, top + plot_h):
                        if (x + y) % 4 == 0 and (y // 2) % 2 == 0:
                            canvas.px(x, y, DIM)
        for (x0, y0), (x1, y1) in zip(points, points[1:]):
            canvas.line(x0, y0, x1, y1, colors[index % 4])
    canvas.text(24, 20, title, FG, 3)
    x = 24
    for index, (label, key, rows) in enumerate(data):
        canvas.rect(x, 64, x + 12, 76, colors[index % 4])
        x = canvas.text(x + 20, 64, f"{label} {fmt_value(rows[-1][1], kind)}", MUTED) + 24
    fmt = "%H:%M" if seconds <= 86400 else "%b %d"
    for i in range(5):
        ts = start + seconds * i // 4
        label = datetime.fromtimestamp(ts, TZ).strftime(fmt)
        canvas.text(min(width - right - len(label) * 12, max(left, left + plot_w * i // 4 - len(label) * 6)),
                    height - bottom + 18, label, MUTED)
    summary = []
    for label, key, rows in data:
        values = [r[1] for r in rows]
        summary.append(f"{label}: now {fmt_value(values[-1], kind)}, avg {fmt_value(sum(values) / len(values), kind)}, "
                       f"min {fmt_value(min(values), kind)}, peak {fmt_value(max(r[2] for r in rows), kind)}")
    return canvas.png(), "\n".join(summary)


def graph_series(name):
    name = name.lower().strip()
    iface = default_iface()[0] or "eth0"
    named = {
        "cpu": [("cpu", "cpu")], "mem": [("memory", "mem")], "memory": [("memory", "mem")], "ram": [("memory", "mem")],
        "temp": [("cpu", "temp:cpu:package")], "temperature": [("cpu", "temp:cpu:package")],
        "net": [("in", f"net:{iface}:rx"), ("out", f"net:{iface}:tx")],
        "network": [("in", f"net:{iface}:rx"), ("out", f"net:{iface}:tx")],
        "tailscale": [("in", "net:tailscale0:rx"), ("out", "net:tailscale0:tx")],
        "disk": [("data", "vol:data:used"), ("system", "vol:system:used"), ("backup", "vol:backup:used")],
        "storage": [("data", "vol:data:used"), ("system", "vol:system:used"), ("backup", "vol:backup:used")],
        "containers": [("containers", "containers")],
    }
    if name in named:
        return named[name], name
    keys = history_keys()
    if name in keys:
        return [(name.split(":")[-2] if ":" in name else name, name)], name
    matches = [k for k in keys if name in k.lower()][:4]
    return [(k.split(":", 1)[-1], k) for k in matches], name


def chart(name, rng="24h"):
    series, title = graph_series(name)
    if not series:
        return None, f"unknown graph '{name}'. try cpu, mem, temp, net, disk, containers or any history key"
    seconds = span(rng, "24h")
    png, summary = render_chart(f"{title} · {rng}", series, seconds)
    return png, summary


# ---------------------------------------------------------------- read tools (commands and AI)


def box_status():
    lines = []
    uptime = float(open("/proc/uptime").read().split()[0])
    load = open("/proc/loadavg").read().split()[:3]
    mem = dict((l.split(":")[0], int(l.split()[1]) * 1024) for l in open("/proc/meminfo"))
    lines.append(f"host {socket.gethostname()} · up {ago(time.time() - uptime)} · load {' '.join(load)} "
                 f"({os.cpu_count()} cores)")
    cpu, temp = latest("cpu"), latest("temp:cpu:package")
    lines.append(f"cpu {fmt_value(cpu, 'pct')} · temp {fmt_value(temp, 'temp')} · memory "
                 f"{human_bytes(mem['MemTotal'] - mem['MemAvailable'])} of {human_bytes(mem['MemTotal'])} · swap used "
                 f"{human_bytes(mem.get('SwapTotal', 0) - mem.get('SwapFree', 0))}")
    for path, used, total in mounts():
        lines.append(f"disk {path}: {human_bytes(used)} of {human_bytes(total)} ({used / total * 100:.0f}%)")
    rows = containers()
    running = sum(r["state"] == "running" for r in rows)
    lines.append(f"containers: {running} running of {len(rows)}")
    problems = [f"{r['name']} ({r['status']})" for r in rows
                if r["state"] == "restarting" or r["unhealthy"] or (r["exit"] not in (None, 0, 137, 143) and not r["swarm"])]
    if problems:
        lines.append("container problems: " + "; ".join(problems[:12]))
    monitors = kuma_monitors()
    if monitors:
        down = [m["name"] for m in monitors.values() if m["status"] == 0]
        lines.append(f"uptime kuma: {sum(m['status'] == 1 for m in monitors.values())}/{len(monitors)} up"
                     + (f", down: {', '.join(down)}" if down else ""))
    failed = [j["name"] for j in jobs() if j.get("lastResult") == "failed"]
    if failed:
        lines.append("jobs whose last run failed: " + ", ".join(failed))
    if os.path.exists("/var/run/reboot-required"):
        lines.append("a reboot is required for updates")
    return "\n".join(lines)


def net_status():
    iface, gateway = default_iface()
    lines = []
    if iface:
        carrier = open(f"/sys/class/net/{iface}/carrier").read().strip() if os.path.exists(f"/sys/class/net/{iface}/carrier") else "?"
        try:
            speed = open(f"/sys/class/net/{iface}/speed").read().strip() + " Mb/s"
        except OSError:
            speed = "?"
        _, addr = run(["ip", "-4", "-o", "addr", "show", "dev", iface])
        lan = re.search(r"inet (\S+)", addr)
        lines.append(f"link {iface}: {'up' if carrier == '1' else 'DOWN'} {speed} · lan {lan.group(1) if lan else '?'} · gateway {gateway}")
    else:
        lines.append("no default route (no network)")
    lines.append(f"internet: {'reachable' if online() else 'NOT reachable'}")
    try:
        started = time.time()
        socket.getaddrinfo("api.telegram.org", 443)
        lines.append(f"dns (system resolver): ok in {(time.time() - started) * 1000:.0f} ms")
    except OSError as error:
        lines.append(f"dns (system resolver): FAILING ({error}); the bot uses dns-over-https meanwhile")
    try:
        status, raw = https("GET", "https://api.ipify.org", timeout=8)
        public = raw.decode().strip()
        lines.append(f"public ip: {public}")
        if ENV.get("DDNS_HOST"):
            conn = http.client.HTTPSConnection("1.1.1.1", timeout=8)
            conn.request("GET", f"/dns-query?name={ENV['DDNS_HOST']}&type=A", headers={"accept": "application/dns-json"})
            answers = [a["data"] for a in json.load(conn.getresponse()).get("Answer", []) if a.get("type") == 1]
            lines.append(f"ddns {ENV['DDNS_HOST']}: {', '.join(answers) or 'no record'}"
                         + (" (matches)" if public in answers else " (MISMATCH, run /fix ddns)"))
    except (OSError, ValueError) as error:
        lines.append(f"public ip: unknown ({error})")
    code, out = run(["tailscale", "status", "--json"], 15)
    try:
        ts = json.loads(out)
        peers = ts.get("Peer") or {}
        lines.append(f"tailscale: {ts.get('BackendState')} · {', '.join((ts.get('Self') or {}).get('TailscaleIPs', [])[:1])}"
                     f" · {sum(p.get('Online', False) for p in peers.values())}/{len(peers)} peers online"
                     + (f" · health: {'; '.join(ts.get('Health') or [])}" if ts.get("Health") else ""))
    except ValueError:
        lines.append(f"tailscale: not answering ({clip(out, 200)})")
    return "\n".join(lines)


def container_list(filter_text="", only_problems=False):
    rows = containers()
    if filter_text:
        rows = [r for r in rows if filter_text.lower() in r["name"].lower() or filter_text.lower() in r["image"].lower()]
    if only_problems:
        rows = [r for r in rows if r["state"] != "running" or r["unhealthy"]]
    return "\n".join(f"{r['name']} · {r['state']} · {r['status']} · {r['image'].split('@')[0][:60]}" for r in rows) or "none"


def container_logs(name, since="1h", tail=200, grep=None):
    row, error = find_container(name)
    if error:
        return error, None
    args = ["docker", "logs", "--timestamps", "--since", since if re.fullmatch(r"\d+[smhd]", since or "") else "1h",
            "--tail", str(max(10, min(int(tail or 200), 5000))), row["name"]]
    code, out = run(args, 30)
    if grep:
        out = "\n".join(l for l in out.splitlines() if grep.lower() in l.lower())
    return out or "(no log lines in that window)", row["name"]


def host_logs(unit=None, since="1h", tail=200, grep=None, priority=None):
    args = ["journalctl", "--no-pager", "-o", "short-iso", "-n", str(max(10, min(int(tail or 200), 5000))),
            "--since", f"-{span(since)}s"]
    if unit:
        if not re.fullmatch(r"[\w@.:-]+", unit):
            return "bad unit name"
        args += ["-u", unit if "." in unit else f"{unit}.service"]
    if priority in ("emerg", "alert", "crit", "err", "warning", "notice", "info", "debug"):
        args += ["-p", priority]
    if grep:
        args += ["--grep", grep, "--case-sensitive=false"]
    code, out = run(args, 30)
    return out or "(no journal lines in that window)"


def jobs_text():
    rows = []
    for job in jobs():
        last = f"{job.get('lastResult') or 'never run'}" + (f" {ago(job['lastRun'])} ago" if job.get("lastRun") else "")
        nxt = f" · next {local(job['nextRun'], '%a %H:%M')}" if job.get("nextRun") else ""
        rows.append(f"{job['name']} ({job.get('schedule')}): {last}{nxt} — {job.get('description', '')}")
    return "\n".join(rows) or "no jobs.json"


def docker_space():
    code, out = run(["docker", "system", "df", "-v", "--format", "{{json .}}"], 120)
    try:
        df = json.loads(out)
    except ValueError:
        return f"docker system df failed: {clip(out, 300)}"
    images = df.get("Images") or []
    unused = sorted((i for i in images if str(i.get("Containers")) == "0"), key=lambda i: -parse_size(i.get("Size")))
    dangling = [i for i in unused if i.get("Repository") == "<none>"]
    stopped = [c for c in df.get("Containers") or [] if c.get("State") != "running"]
    volumes = sorted((v for v in df.get("Volumes") or [] if str(v.get("Links")) == "0"), key=lambda v: -parse_size(v.get("Size")))
    cache = df.get("BuildCache") or []
    cache_total = sum(parse_size(c.get("Size")) for c in cache)
    cache_free = sum(parse_size(c.get("Size")) for c in cache if str(c.get("InUse")).lower() != "true")
    week = [c for c in cache if "week" in c.get("LastUsedAt", "") or "month" in c.get("LastUsedAt", "")]
    lines = [f"images: {len(images)} total, {len(unused)} unused by any container "
             f"({human_bytes(sum(parse_size(i.get('Size')) for i in unused))}), {len(dangling)} dangling",
             f"build cache: {human_bytes(cache_total)} total, {human_bytes(cache_free)} reclaimable",
             f"stopped containers: {len(stopped)}",
             f"unused volumes: {len(volumes)} ({human_bytes(sum(parse_size(v.get('Size')) for v in volumes))}) — volumes hold app data",
             "", "largest unused images (id · repo:tag · size · created):"]
    lines += [f"{i.get('ID', '')[7:19] if str(i.get('ID', '')).startswith('sha256:') else str(i.get('ID', ''))[:12]} · "
              f"{i.get('Repository')}:{i.get('Tag')} · {i.get('Size')} · {i.get('CreatedSince')}" for i in unused[:25]]
    if stopped:
        lines += ["", "stopped containers:"] + [f"{c.get('Names')} · {c.get('Status')} · {c.get('Image')}" for c in stopped[:20]]
    if volumes:
        lines += ["", "unused volumes:"] + [f"{v.get('Name')} · {v.get('Size')}" for v in volumes[:20]]
    lines.append(f"\nbuild cache entries not used in over a week: {len(week)}")
    return "\n".join(lines)


DASHBOARD_FILES = ["reachability", "smart", "backrest-status", "disk-watch", "network-devices", "usage", "usage-alerts",
                   "cleanup-runs", "upgrade-state", "tidy", "n8n-status", "activity", "limits", "digest", "journal",
                   "actions", "agent", "jobs"]


def dashboard_data(name):
    if name not in DASHBOARD_FILES:
        return "unknown file; choose one of " + ", ".join(DASHBOARD_FILES)
    data = read_json(f"{DATA}/{name}.json")
    if data is None:
        return "missing or unreadable"
    if name == "activity" and isinstance(data, dict):
        data = {**data, "events": data.get("events", [])[-80:]}
    return clip(json.dumps(data, indent=None, default=str), 9000)


READONLY = {
    "df": None, "du": None, "free": None, "uptime": None, "ip": None, "ss": None, "ls": None, "ps": None,
    "lsblk": None, "uname": None, "hostnamectl": None, "timedatectl": None, "sensors": None, "who": None, "w": None,
    "last": None, "ping": None, "dig": None, "host": None, "nslookup": None, "traceroute": None, "tracepath": None,
    "lscpu": None, "nproc": None, "date": None, "cat": None, "head": None, "tail": None, "wc": None, "stat": None,
    "findmnt": None, "networkctl": {"status", "list"}, "resolvectl": {"status", "query", "statistics"},
    "systemctl": {"status", "list-timers", "list-units", "is-active", "is-failed", "show", "list-unit-files", "cat"},
    "docker": {"ps", "images", "stats", "system", "events", "network", "volume", "service", "node", "top", "port", "version", "info"},
    "tailscale": {"status", "ip", "netcheck", "version", "ping"}, "smartctl": {"-H", "-a", "-A", "-i"},
    "apt": {"list"}, "curl": None, "top": None, "iostat": None, "vmstat": None, "journalctl": None, "ufw": {"status"},
}
SECRET_PATHS = re.compile(r"(/etc/keep|\.env\b|shadow|secret|token|key|password|credential|/root/)", re.I)


def readonly_command(command):
    try:
        args = shlex.split(command)
    except ValueError as error:
        return f"cannot parse: {error}"
    if not args or args[0] not in READONLY:
        return f"not allowed; read-only commands are: {', '.join(sorted(READONLY))}. Anything else needs propose_shell."
    allowed = READONLY[args[0]]
    if allowed is not None and (len(args) < 2 or args[1] not in allowed):
        return f"{args[0]} is limited to: {', '.join(sorted(allowed))}"
    if args[0] == "docker" and args[1] in ("system", "network", "volume", "service", "node") \
            and (len(args) < 3 or args[2] not in ("df", "ls", "ps", "info")):
        return "only listing subcommands are allowed (df, ls, ps, info); inspect can expose secrets"
    if args[0] == "docker" and args[1] == "events":
        args += [] if "--since" in args else ["--since", "1h"]
        args += [] if "--until" in args else ["--until", str(int(time.time()))]
    if any(a in ("-f", "--follow", "-F") for a in args[1:]) and args[0] in ("tail", "journalctl", "docker"):
        return "following output is not allowed; use a time window"
    if args[0] == "curl" and any(a in args for a in ("-X", "--request", "-d", "--data", "-o", "--output", "-T", "-F")):
        return "curl is limited to GET requests without writing files"
    if args[0] in ("cat", "head", "tail", "stat", "ls") and any(SECRET_PATHS.search(a) for a in args[1:]):
        return "that path may hold secrets; not readable by the AI"
    if args[0] == "docker" and args[1] == "stats" and "--no-stream" not in args:
        args.insert(2, "--no-stream")
    if args[0] == "top" and "-b" not in args:
        args += ["-b", "-n", "1"]
    if args[0] == "ping" and "-c" not in args:
        args[1:1] = ["-c", "4"]
    code, out = run(args, 45)
    return clip(f"exit {code}\n{out}", 9000)


def n8n_workflows():
    rows = n8n_query("""SELECT coalesce(json_agg(w ORDER BY w.name), '[]') FROM (
        SELECT w.id, w.name, w.active, w."updatedAt",
          (SELECT count(*) FROM execution_entity e WHERE e."workflowId" = w.id AND e."startedAt" > now() - interval '24 hours') AS runs_24h,
          (SELECT count(*) FROM execution_entity e WHERE e."workflowId" = w.id AND e.status IN ('error', 'crashed')
             AND e."startedAt" > now() - interval '24 hours') AS failed_24h
        FROM workflow_entity w WHERE coalesce(w."isArchived", false) = false) w""")
    return "\n".join(f"{w['id']} · {w['name']} · {'active' if w['active'] else 'inactive'} · {w['runs_24h']} runs / "
                     f"{w['failed_24h']} failed in 24h" for w in rows or []) or "no workflows"


def n8n_executions(workflow=None, status=None, hours=24, limit=30):
    where = [f"e.\"startedAt\" > now() - interval '{max(1, min(int(hours or 24), 24 * 60))} hours'"]
    if workflow:
        where.append(f"(w.name ILIKE {sql_text('%' + workflow + '%')} OR w.id = {sql_text(workflow)})")
    if status in ("success", "error", "crashed", "running", "waiting", "canceled"):
        where.append(f"e.status = {sql_text(status)}")
    rows = n8n_query(f"""SELECT coalesce(json_agg(x), '[]') FROM (
        SELECT e.id, w.name AS workflow, e.status, e.mode, e."startedAt", e."stoppedAt"
        FROM execution_entity e LEFT JOIN workflow_entity w ON w.id = e."workflowId"
        WHERE {' AND '.join(where)} ORDER BY e."startedAt" DESC LIMIT {max(1, min(int(limit or 30), 200))}) x""")
    if not rows:
        return ("no executions in that window. note: n8n may not keep successful runs; check the retention settings "
                "(EXECUTIONS_DATA_SAVE_ON_SUCCESS / EXECUTIONS_DATA_MAX_AGE)")
    out = []
    for r in rows:
        started = datetime.fromisoformat(r["startedAt"].replace("Z", "+00:00")) if r.get("startedAt") else None
        stopped = datetime.fromisoformat(r["stoppedAt"].replace("Z", "+00:00")) if r.get("stoppedAt") else None
        took = f"{(stopped - started).total_seconds():.1f}s" if started and stopped else "-"
        out.append(f"#{r['id']} · {r['workflow']} · {r['status']} · {r['mode']} · "
                   f"{started.astimezone(TZ).strftime('%b %d %H:%M:%S') if started else '?'} · {took}")
    return "\n".join(out)


def n8n_execution(execution_id):
    if not str(execution_id).isdigit():
        return "execution id must be a number"
    row = n8n_query(f"""SELECT row_to_json(x) FROM (
        SELECT e.id, w.name AS workflow, e.status, e.mode, e."startedAt", e."stoppedAt", d.data
        FROM execution_entity e LEFT JOIN workflow_entity w ON w.id = e."workflowId"
        LEFT JOIN execution_data d ON d."executionId" = e.id WHERE e.id = {int(execution_id)}) x""")
    if not row:
        return "no such execution"
    head = f"#{row['id']} · {row['workflow']} · {row['status']} · {row['mode']} · {row['startedAt']} → {row['stoppedAt']}"
    if not row.get("data"):
        return head + "\n(no node data stored for this run)"
    try:
        data = unflatten(row["data"])
    except (ValueError, IndexError, RecursionError) as error:
        return head + f"\n(could not decode run data: {error})\n" + clip(row["data"], 3000)
    result = (data or {}).get("resultData") or {}
    lines = [head]
    if result.get("error"):
        err = result["error"]
        lines.append(f"workflow error: {err.get('message')} {err.get('description') or ''}".strip())
    if result.get("lastNodeExecuted"):
        lines.append(f"last node: {result['lastNodeExecuted']}")
    for node, runs in (result.get("runData") or {}).items():
        for run_info in runs or []:
            items = (((run_info or {}).get("data") or {}).get("main") or [[]])
            outputs = [len(branch or []) for branch in items]
            first = next((b[0].get("json") for b in items if b), None)
            status = run_info.get("executionStatus") or ("error" if run_info.get("error") else "success")
            line = f"• {node}: {status}, {run_info.get('executionTime', '?')} ms, items out {outputs}"
            if run_info.get("error"):
                line += f", error: {(run_info['error'] or {}).get('message')}"
            if first is not None:
                line += f"\n    first item: {clip(json.dumps(first, default=str), 400)}"
            lines.append(line)
    return clip("\n".join(lines), 9000)


# ---------------------------------------------------------------- actions (only ever run after a tap)

FIXES = {
    "network": "re-apply the ethernet config and flush dns",
    "dns": "restart systemd-resolved and flush its cache",
    "tailscale": "restart tailscaled, and send a login link if it needs one",
    "ddns": "update the home dns record now",
    "traefik": "restart the traefik reverse proxy",
    "dokploy": "force-restart the dokploy service",
    "adguard": "restart the adguard dns container",
    "docker": "restart the docker daemon (every container restarts)",
}
HEAVY = {"reboot", "shell", "fix:docker", "cleanup"}


def describe(action):
    kind = action["do"]
    return {
        "restart": lambda: f"restart {action.get('arg')}",
        "run": lambda: f"run job {action.get('arg')}",
        "fix": lambda: f"fix {action.get('arg')}: {FIXES.get(action.get('arg'), '')}",
        "reboot": lambda: "reboot the box" + (" tonight at 03:00" if action.get("when") == "tonight" else " now"),
        "shell": lambda: f"run as root: {action.get('arg')}",
        "cleanup": lambda: "docker cleanup: " + cleanup_summary(action),
        "tidy": lambda: "run keep-tidy (cache and log cleanup)",
    }.get(kind, lambda: kind)()


def cleanup_summary(action):
    parts = []
    if action.get("build_cache") in ("old", "all"):
        parts.append("build cache " + ("older than 7 days" if action["build_cache"] == "old" else "(all)"))
    if action.get("all_unused_images"):
        parts.append("every unused image")
    elif action.get("dangling_images"):
        parts.append("dangling images")
    if action.get("images"):
        parts.append(f"{len(action['images'])} image(s)")
    if action.get("containers"):
        parts.append(f"{len(action['containers'])} stopped container(s)")
    if action.get("volumes"):
        parts.append(f"{len(action['volumes'])} volume(s) — their data is lost")
    return ", ".join(parts) or "nothing selected"


def do_fix(target):
    iface, _ = default_iface()
    if target == "network":
        out = [run(["networkctl", "reconfigure", iface or "enp5s0"])[1], run(["resolvectl", "flush-caches"])[1]]
        time.sleep(8)
        return "network re-applied. " + ("internet is back." if online() else "still offline.") + " " + " ".join(o for o in out if o)
    if target == "dns":
        run(["systemctl", "restart", "systemd-resolved"])
        run(["resolvectl", "flush-caches"])
        try:
            socket.getaddrinfo("api.telegram.org", 443)
            return "systemd-resolved restarted, dns works"
        except OSError as error:
            return f"restarted but dns still fails: {error}. check /fix adguard"
    if target == "tailscale":
        run(["systemctl", "restart", "tailscaled"], 60)
        time.sleep(8)
        code, out = run(["tailscale", "status", "--json"], 15)
        state = (json.loads(out) if code == 0 and out.startswith("{") else {}).get("BackendState")
        if state == "Running":
            return "tailscaled restarted, tailscale is connected"
        code, out = run(["tailscale", "login", "--timeout=25s"], 40)
        url = re.search(r"https://login\.tailscale\.com/\S+", out)
        return (f"tailscale needs a login. open this, then run /net:\n{url.group(0)}" if url
                else f"tailscale state {state}: {clip(out, 600)}")
    if target == "ddns":
        code, out = run(["systemctl", "start", "keep-ddns.service"], 60)
        return f"keep-ddns ran (exit {code}). {clip(out, 400)}"
    if target in ("traefik", "adguard"):
        row = next((r for r in containers() if (target == "traefik" and r["name"] == "dokploy-traefik")
                    or (target == "adguard" and "adguard" in r["name"])), None)
        if not row:
            return f"{target} container not found"
        code, out = run(["docker", "restart", "-t", "20", row["name"]], 90)
        return f"restarted {row['name']}" if code == 0 else f"restart failed: {clip(out, 400)}"
    if target == "dokploy":
        code, out = run(["docker", "service", "update", "--force", "--detach", "dokploy"], 90)
        return "dokploy service restarting" if code == 0 else f"failed: {clip(out, 400)}"
    if target == "docker":
        code, out = run(["systemctl", "restart", "docker"], 300)
        return "docker restarted" if code == 0 else f"failed: {clip(out, 400)}"
    return f"unknown fix target; choose: {', '.join(FIXES)}"


def do_cleanup(action):
    before = shutil.disk_usage("/srv" if os.path.ismount("/srv") else "/").free
    out = []
    if action.get("build_cache") == "all":
        out.append(run(["docker", "builder", "prune", "-af"], 900)[1].splitlines()[-1:])
    elif action.get("build_cache") == "old":
        out.append(run(["docker", "builder", "prune", "-af", "--filter", "until=168h"], 900)[1].splitlines()[-1:])
    if action.get("all_unused_images"):
        out.append(run(["docker", "image", "prune", "-af"], 900)[1].splitlines()[-1:])
    elif action.get("dangling_images"):
        out.append(run(["docker", "image", "prune", "-f"], 600)[1].splitlines()[-1:])
    for image in action.get("images") or []:
        code, text = run(["docker", "rmi", image], 300)
        out.append([f"{image}: {'removed' if code == 0 else clip(text, 150)}"])
    for name in action.get("containers") or []:
        code, text = run(["docker", "rm", name], 120)
        out.append([f"{name}: {'removed' if code == 0 else clip(text, 150)}"])
    for name in action.get("volumes") or []:
        code, text = run(["docker", "volume", "rm", name], 120)
        out.append([f"volume {name}: {'removed' if code == 0 else clip(text, 150)}"])
    after = shutil.disk_usage("/srv" if os.path.ismount("/srv") else "/").free
    return f"freed {human_bytes(after - before)}\n" + "\n".join(" ".join(o) for o in out if o)


def perform(action):
    """Runs one action and returns a short result. Callers decide whether a tap / PIN was needed."""
    kind, arg = action["do"], action.get("arg")
    if kind == "restart":
        row, error = find_container(arg)
        if error:
            return error
        if row["swarm"]:
            code, out = run(["docker", "service", "update", "--force", "--detach", row["swarm"]], 120)
            return f"service {row['swarm']} restarting" if code == 0 else f"failed: {clip(out, 400)}"
        code, out = run(["docker", "restart", "-t", "20", row["name"]], 120)
        return f"restarted {row['name']}" if code == 0 else f"failed: {clip(out, 400)}"
    if kind == "run":
        known = {j["name"] for j in jobs()}
        if arg not in known and not (re.fullmatch(r"keep-[\w-]+", arg or "") and run(["systemctl", "cat", f"{arg}.service"])[0] == 0):
            return f"unknown job {arg}"
        code, out = run(["systemctl", "start", "--no-block", f"{arg}.service"])
        return f"started {arg}; its result lands in ⚙️ jobs" if code == 0 else f"failed: {clip(out, 400)}"
    if kind == "tidy":
        run(["systemctl", "start", "--no-block", "keep-tidy.service"])
        return "keep-tidy started"
    if kind == "fix":
        return do_fix(arg)
    if kind == "cleanup":
        return do_cleanup(action)
    if kind == "shell":
        code, out = run(["bash", "-lc", arg], 120)
        return f"exit {code}\n{out or '(no output)'}"
    if kind == "reboot":
        if action.get("when") == "tonight":
            code, out = run(["systemd-run", "--unit=keep-bot-reboot", "--on-calendar=*-*-* 03:00:00", "systemctl", "reboot"])
            return "reboot scheduled for 03:00" if code == 0 else f"failed: {clip(out, 300)}"
        if float(open("/proc/uptime").read().split()[0]) < 300:
            return "refused: the box booted less than 5 minutes ago"
        with LOCK:
            STATE["reboot_note"] = {"at": time.time(), "by": "button"}
        save_state()
        threading.Timer(3, lambda: run(["systemctl", "reboot"])).start()
        return "rebooting now; i'll post when it's back"
    return f"unknown action {kind}"


# ---------------------------------------------------------------- the AI

AI_TOOLS = [
    ("box_status", "Overall health right now: uptime, load, cpu, temperature, memory, every disk, container counts and problems, Uptime Kuma, failed jobs, pending reboot.", {}),
    ("network_status", "Network right now: ethernet link, LAN IP, gateway, internet reachability, DNS, public IP vs DDNS record, Tailscale state.", {}),
    ("list_containers", "List Docker containers with state, status and image. Use filter to narrow by name or image.",
     {"filter": ("string", "substring of the container name or image"), "only_problems": ("boolean", "only non-running or unhealthy ones")}),
    ("container_logs", "Logs of one container (fuzzy name match, e.g. 'n8n', 'traefik'). Set as_file=true to send the raw log to the chat as a file.",
     {"name": ("string", "container name or part of it", True), "since": ("string", "e.g. 30m, 2h, 1d"),
      "tail": ("integer", "max lines, default 200"), "grep": ("string", "only lines containing this"),
      "as_file": ("boolean", "send the raw log as a file to the owner")}),
    ("host_logs", "Host journal (systemd): a unit like keep-tidy, docker, tailscaled, ssh, or everything. Set as_file=true for a raw file.",
     {"unit": ("string", "systemd unit, optional"), "since": ("string", "e.g. 30m, 2h, 1d"), "tail": ("integer", "max lines"),
      "grep": ("string", "case-insensitive pattern"), "priority": ("string", "err, warning, info …"),
      "as_file": ("boolean", "send the raw log as a file")}),
    ("jobs", "Scheduled keep-* jobs: schedule, last result, when it ran, next run, what it does.", {}),
    ("metric", "History of a metric with stats. Names: cpu, mem, temp, net, tailscale, disk, containers, or a raw history key "
               "(e.g. kuma:3:ms, bucket:ente:bytes, temp:gpu:edge). chart=true also sends a chart image to the owner.",
     {"name": ("string", "metric name", True), "range": ("string", "1h, 6h, 24h, 7d, 30d"), "chart": ("boolean", "send a chart image")}),
    ("uptime_monitors", "Every Uptime Kuma monitor with status (up/down/pending/maintenance), url and response time.", {}),
    ("docker_space", "What Docker uses on disk and what can be cleaned: unused images with ids and sizes, build cache, stopped containers, unused volumes.", {}),
    ("container_stats", "Live CPU and memory per container (top consumers).", {}),
    ("dashboard_data", "Raw JSON the dashboard keeps. Files: " + ", ".join(DASHBOARD_FILES) + ". activity = logins/sudo/boots; reachability = public site checks; smart = drive health; backrest-status = backups; usage = space per app; network-devices = tailnet devices.",
     {"file": ("string", "one of the files", True)}),
    ("readonly_command", "Run one read-only diagnostic command (no shell, no pipes): df, du, free, ip, ss, ps, top, lsblk, sensors, "
                         "systemctl status/list-timers/show, docker ps/images/stats/system df/events/service ls/ps, tailscale status/netcheck, "
                         "resolvectl, ping, dig, curl (GET), journalctl, smartctl, apt list --upgradable, cat of non-secret files.",
     {"command": ("string", "the command line", True)}),
    ("n8n_workflows", "All n8n workflows with active flag and runs/failures in the last 24h.", {}),
    ("n8n_executions", "Recent n8n executions (runs) with status and duration.",
     {"workflow": ("string", "workflow name part or id"), "status": ("string", "success, error, crashed, running, waiting"),
      "hours": ("integer", "look-back window, default 24"), "limit": ("integer", "max rows, default 30")}),
    ("n8n_execution", "One n8n execution in detail: each node's status, duration, item counts, first output item and errors.",
     {"id": ("integer", "execution id", True)}),
    ("ask_user", "Ask the owner to choose, shown as buttons. Use it whenever several reasonable options exist (what to delete, which container, how far to go). "
                 "Put the facts (sizes, names) in the question. The conversation pauses until they tap; their choice comes back as their next message.",
     {"question": ("string", "the question with the relevant facts", True),
      "options": ("array", "2-10 short option labels (max 40 chars each)", True),
      "multi": ("boolean", "allow choosing several, then a Done button")}),
    ("propose_restart", "Propose restarting a container or swarm service; the owner gets a button.",
     {"container": ("string", "container name or part", True), "reason": ("string", "one line why", True)}),
    ("propose_run_job", "Propose running a keep-* job now.", {"job": ("string", "job name", True), "reason": ("string", "why", True)}),
    ("propose_fix", "Propose a built-in repair: " + "; ".join(f"{k} = {v}" for k, v in FIXES.items()) + ".",
     {"target": ("string", "one of " + ", ".join(FIXES), True), "reason": ("string", "why", True)}),
    ("propose_cleanup", "Propose a Docker cleanup with exactly what the owner chose. Get ids and sizes from docker_space first.",
     {"build_cache": ("string", "none, old (unused > 7 days) or all"), "dangling_images": ("boolean", "remove dangling images"),
      "all_unused_images": ("boolean", "remove every image no container uses"),
      "images": ("array", "specific image ids or repo:tag"), "containers": ("array", "stopped container names"),
      "volumes": ("array", "volume names (destroys their data; only if the owner explicitly chose them)"),
      "reason": ("string", "one line summary with the expected space freed", True)}),
    ("propose_reboot", "Propose rebooting the box now or tonight at 03:00.",
     {"when": ("string", "now or tonight", True), "reason": ("string", "why", True)}),
    ("propose_shell", "Propose an arbitrary root shell command when no other tool fits. The owner must confirm with their PIN.",
     {"command": ("string", "bash command", True), "reason": ("string", "what it does and why", True)}),
]


def tool_schema():
    out = []
    for name, desc, params in AI_TOOLS:
        props, required = {}, []
        for pname, spec in params.items():
            kind, pdesc = spec[0], spec[1]
            props[pname] = {"type": kind, "description": pdesc}
            if kind == "array":
                props[pname]["items"] = {"type": "string"}
            if len(spec) > 2 and spec[2]:
                required.append(pname)
        out.append({"type": "function", "function": {"name": name, "description": desc,
                                                     "parameters": {"type": "object", "properties": props, "required": required}}})
    return out


SYSTEM_PROMPT = """You are "the keep", the operator of a self-hosted home server (hostname {host}) that you run for its owner. You talk to the owner in a private Telegram group with topics. You are their sysadmin: sharp, calm, precise, and you know this box inside out because you look things up instead of guessing.

The box: Ubuntu, root access through your tools. Dokploy runs the apps (Docker Swarm services and compose projects) behind Traefik. Tailscale for private access, AdGuard Home for DNS, Uptime Kuma for uptime checks, n8n for automations (mail workflows among them), Garage (S3) for buckets, Backrest for backups to a separate HDD, healthchecks.io watches the box from outside. keep-* systemd timers do housekeeping (tidy, cleanup, backups, smart, ddns, reachability, upgrades). A dashboard records metric history (cpu, memory, temperatures, network, disks, buckets, uptime) that the metric tool reads.

Right now ({now}, {tz}):
{snapshot}

The conversation is in {topic}.

Where things are (use the right tool):
- keep-* jobs are systemd units, not containers: jobs for the schedule and results, host_logs(unit=<job>) for what a run printed.
- Public sites as seen from outside: dashboard_data("reachability"). Backups: dashboard_data("backrest-status"). Disk space per app: dashboard_data("usage"). Drive health: dashboard_data("smart"). Logins, sudo, boots: dashboard_data("activity"). Tailnet devices: dashboard_data("network-devices").
- Uptime checks: uptime_monitors. Apps and services: list_containers / container_logs (fuzzy names work: "n8n", "traefik", "lehoetel"). Swarm services: readonly_command("docker service ls").
- n8n: n8n_workflows → n8n_executions → n8n_execution(id) for what each node did; container_logs("n8n") for the server log.
- Docker disk: docker_space. Metrics over time: metric.

How you work:
- Be specific: name the exact sites, containers, jobs, sizes and times involved, never just "some".
- Investigate first. Call tools to get real data before you answer; chain them (status → logs → metrics → journal) until you know the cause. Never invent numbers, names, ids or causes. If something can't be known, say so.
- You cannot change anything yourself. Changes go through propose_* tools, which show the owner a button. Never say something is done until a result comes back. Prefer the least disruptive fix (restart one container before restarting docker; old build cache before all images).
- When there is a real choice — what to delete, which of several containers, how aggressive — use ask_user with buttons. Put the facts in the question (sizes, ages, what each item is), recommend one option, and keep labels short. Example: for "docker is eating my disk", call docker_space, then ask which of: build cache older than 7 days (size), all build cache (size), unused images (count, size), stopped containers, unused volumes (warn: data loss); then propose_cleanup with exactly that.
- Volumes, databases and backups hold data. Never propose deleting them unless the owner explicitly picked them, and say plainly that it is irreversible.
- Raw logs: when the owner asks for raw logs or the output is long, use as_file=true so they get a file, and give a 2-3 line summary of what's in it.
- Charts: when a trend explains things (spikes, filling disks, temperatures), call metric with chart=true.
- Write for a phone: short lines, plain words, no tables, no headings, at most a few bullets with "•". Use **bold** sparingly for the key fact and `code` for names. Lead with the answer, then the evidence. Include units and times (in {tz}).
- Reply in the language the owner writes in.
- If a tool fails, say what failed and try another route (e.g. readonly_command)."""


CONVERSATIONS = {}
THREAD_LOCKS = {}
CHOICES = {}


def groq(messages):
    key = ENV.get("GROQ_API_KEY")
    if not key:
        raise RuntimeError("GROQ_API_KEY is missing in /etc/keep/bot.env")
    body = {"model": MODEL, "messages": messages, "tools": tool_schema(), "tool_choice": "auto", "temperature": 0.2,
            "max_completion_tokens": 4096, "reasoning_effort": ENV.get("AI_REASONING", "medium")}
    for attempt in range(3):
        status, raw = https("POST", "https://api.groq.com/openai/v1/chat/completions", json.dumps(body).encode(),
                            {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}, 120)
        data = json.loads(raw or b"{}")
        if status == 429 and attempt < 2:
            time.sleep(min(30, 5 * (attempt + 1)))
            continue
        if status != 200:
            raise RuntimeError((data.get("error") or {}).get("message", f"groq http {status}"))
        usage = (data.get("usage") or {}).get("total_tokens", 0)
        with LOCK:
            day = datetime.now(TZ).strftime("%Y-%m-%d")
            spent = STATE.setdefault("ai_tokens", {})
            spent[day] = spent.get(day, 0) + usage
            STATE["ai_tokens"] = dict(sorted(spent.items())[-40:])
        return data["choices"][0]["message"]
    raise RuntimeError("groq is rate limiting; try again in a minute")


def tool_call(name, args, thread, reply_to):
    if name == "box_status":
        return box_status()
    if name == "network_status":
        return net_status()
    if name == "list_containers":
        return clip(container_list(args.get("filter", ""), args.get("only_problems", False)))
    if name == "container_logs":
        out, resolved = container_logs(args.get("name", ""), args.get("since", "1h"), args.get("tail", 200), args.get("grep"))
        if args.get("as_file") and resolved:
            send(thread, f"logs of {resolved} · last {args.get('since', '1h')}", document=(f"{resolved}.log", out.encode()), reply_to=reply_to)
            return f"sent {len(out.splitlines())} lines as a file. last lines:\n" + clip("\n".join(out.splitlines()[-40:]), 3000)
        return clip(out)
    if name == "host_logs":
        out = host_logs(args.get("unit"), args.get("since", "1h"), args.get("tail", 200), args.get("grep"), args.get("priority"))
        if args.get("as_file"):
            send(thread, f"journal {args.get('unit') or 'all units'} · last {args.get('since', '1h')}",
                 document=(f"{args.get('unit') or 'journal'}.log", out.encode()), reply_to=reply_to)
            return f"sent {len(out.splitlines())} lines as a file. last lines:\n" + clip("\n".join(out.splitlines()[-40:]), 3000)
        return clip(out)
    if name == "jobs":
        return jobs_text()
    if name == "metric":
        png, summary = chart(args.get("name", "cpu"), args.get("range", "24h"))
        if png and args.get("chart"):
            send(thread, f"{args.get('name')} · {args.get('range', '24h')}\n{summary}", photo=png, reply_to=reply_to)
            return summary + "\n(chart sent)"
        return summary
    if name == "uptime_monitors":
        monitors = kuma_monitors()
        if monitors is None:
            return "uptime kuma is not reachable"
        names = {1: "up", 0: "DOWN", 2: "pending", 3: "maintenance"}
        return "\n".join(f"{mid} · {m['name']} · {names.get(m['status'], m['status'])} · {m['url']} · "
                         + ("-" if m["ms"] is None else f"{m['ms']:.0f} ms") for mid, m in monitors.items())
    if name == "docker_space":
        return docker_space()
    if name == "container_stats":
        code, out = run(["docker", "stats", "--no-stream", "--format", "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"], 60)
        rows = [l.split("\t") for l in out.splitlines() if l.count("\t") == 2]
        rows.sort(key=lambda r: -float(r[1].rstrip("%") or 0))
        return "\n".join(f"{n} · cpu {c} · mem {m}" for n, c, m in rows[:30]) or clip(out, 2000)
    if name == "dashboard_data":
        return dashboard_data(args.get("file", ""))
    if name == "readonly_command":
        return readonly_command(args.get("command", ""))
    if name == "n8n_workflows":
        return n8n_workflows()
    if name == "n8n_executions":
        return n8n_executions(args.get("workflow"), args.get("status"), args.get("hours", 24), args.get("limit", 30))
    if name == "n8n_execution":
        return n8n_execution(args.get("id"))
    if name == "ask_user":
        options = [str(o)[:40] for o in (args.get("options") or [])][:10]
        if len(options) < 2:
            return "ask_user needs at least two options"
        cid = uuid.uuid4().hex[:8]
        CHOICES[cid] = {"thread": thread, "options": options, "multi": bool(args.get("multi")), "picked": set(),
                        "question": args.get("question", "")}
        send(thread, md_to_html(args.get("question", "choose:")), html=True, markup=choice_markup(cid), reply_to=reply_to)
        return "PAUSE: the question is shown with buttons. Stop here and wait; do not answer it yourself."
    if name.startswith("propose_"):
        return propose(name, args, thread, reply_to)
    return f"unknown tool {name}"


def choice_markup(cid):
    choice = CHOICES[cid]
    rows = []
    for index, label in enumerate(choice["options"]):
        mark = ("☑ " if index in choice["picked"] else "☐ ") if choice["multi"] else ""
        rows.append([{"text": mark + label, "callback_data": f"c:{cid}:{index}"}])
    tail = [{"text": "✖ cancel", "callback_data": f"c:{cid}:x"}]
    if choice["multi"]:
        tail.insert(0, {"text": "✓ done", "callback_data": f"c:{cid}:d"})
    rows.append(tail)
    return {"inline_keyboard": rows}


def propose(name, args, thread, reply_to):
    kind = name.removeprefix("propose_")
    if kind == "restart":
        row, error = find_container(args.get("container", ""))
        if error:
            return error
        action = {"do": "restart", "arg": row["name"]}
    elif kind == "run_job":
        action = {"do": "run", "arg": args.get("job")}
    elif kind == "fix":
        if args.get("target") not in FIXES:
            return "unknown target"
        action = {"do": "fix", "arg": args["target"]}
    elif kind == "cleanup":
        action = {"do": "cleanup", **{k: args.get(k) for k in ("build_cache", "dangling_images", "all_unused_images",
                                                               "images", "containers", "volumes")}}
        if cleanup_summary(action) == "nothing selected":
            return "nothing selected"
    elif kind == "reboot":
        action = {"do": "reboot", "when": "tonight" if args.get("when") == "tonight" else "now"}
    elif kind == "shell":
        action = {"do": "shell", "arg": args.get("command", "")}
    else:
        return "unknown proposal"
    action.update(source="ai", pin=kind == "shell" or bool(action.get("volumes")), once=True)
    text = f"🤖 proposal: <b>{html_escape(describe(action))}</b>\n{html_escape(args.get('reason', ''))}"
    send(thread, text, html=True, reply_to=reply_to,
         buttons=[[("✅ do it", {**action, "confirmed": True}), ("✖ no", "x:cancel")]])
    return "proposal shown with a button. tell the owner briefly what you proposed and why; it runs only if they tap."


def ai_turn(thread, user_text, reply_to, context=None):
    lock = THREAD_LOCKS.setdefault(thread, threading.Lock())
    with lock:
        day = datetime.now(TZ).strftime("%Y-%m-%d")
        if STATE.get("ai_tokens", {}).get(day, 0) > int(ENV.get("AI_DAILY_TOKENS", "3000000")):
            send(thread, "daily ai budget used up (AI_DAILY_TOKENS). commands still work.", reply_to=reply_to)
            return
        convo = CONVERSATIONS.get(thread)
        if not convo or time.time() - convo["at"] > 2 * 3600:
            try:
                snapshot = box_status()
            except Exception as error:  # noqa: BLE001
                snapshot = f"(status unavailable: {error})"
            prompt = SYSTEM_PROMPT.format(host=socket.gethostname(), now=datetime.now(TZ).strftime("%a %b %d %H:%M"),
                                          tz=str(TZ), snapshot=snapshot, topic=TOPIC_CONTEXT.get(topic_of(thread), "a topic"))
            convo = CONVERSATIONS[thread] = {"messages": [{"role": "system", "content": prompt}], "at": time.time()}
        convo["at"] = time.time()
        content = user_text if not context else f"{user_text}\n\n[the owner is replying to this message]\n{context}"
        convo["messages"].append({"role": "user", "content": content})
        try:
            tg("sendChatAction", chat_id=CHAT, message_thread_id=thread, action="typing")
        except Exception:  # noqa: BLE001
            pass
        for _ in range(12):
            message = groq(convo["messages"])
            calls = message.get("tool_calls") or []
            convo["messages"].append({"role": "assistant", "content": message.get("content") or "",
                                      **({"tool_calls": calls} if calls else {})})
            if not calls:
                if (message.get("content") or "").strip():
                    send(thread, md_to_html(message["content"].strip()), html=True, reply_to=reply_to, silent=False)
                break
            paused = False
            for call in calls:
                try:
                    args = json.loads(call["function"].get("arguments") or "{}")
                except ValueError:
                    args = {}
                log("ai tool", call["function"]["name"], json.dumps(args)[:200])
                try:
                    result = tool_call(call["function"]["name"], args, thread, reply_to)
                except Exception as error:  # noqa: BLE001 - errors go back to the model so it can try another way
                    result = f"tool error: {error}"
                paused = paused or result.startswith("PAUSE")
                convo["messages"].append({"role": "tool", "tool_call_id": call["id"], "content": clip(str(result), 9000)})
            if paused:
                break
            try:
                tg("sendChatAction", chat_id=CHAT, message_thread_id=thread, action="typing")
            except Exception:  # noqa: BLE001
                pass
        system, rest = convo["messages"][0], convo["messages"][1:]
        while len(rest) > 40:
            rest = rest[1:]
            while rest and rest[0]["role"] != "user":
                rest = rest[1:]
        convo["messages"] = [system] + rest


def ai_async(thread, text, reply_to, context=None):
    def work():
        try:
            ai_turn(thread, text, reply_to, context)
        except Exception as error:  # noqa: BLE001
            log("ai failed:", traceback.format_exc())
            safe_send(thread, f"ai error: {error}", reply_to=reply_to)
    threading.Thread(target=work, daemon=True).start()


# ---------------------------------------------------------------- commands

HELP = """<b>the keep</b> · talk normally in any topic, or:
/status · health at a glance
/net · network, dns, public ip, tailscale
/fix network|dns|tailscale|ddns|traefik|dokploy|adguard|docker
/graph cpu|mem|temp|net|disk [1h|24h|7d|30d]
/jobs · scheduled jobs  ·  /run &lt;job&gt;
/containers [filter] · /logs &lt;container&gt; [30m]
/restart &lt;container&gt;
/n8n · workflows and recent runs
/space · what docker uses, with cleanup choices
/reboot · /sh &lt;command&gt; (pin)
/digest · send today's digest now
/new · start a fresh ai conversation"""

BOT_COMMANDS = [("status", "health at a glance"), ("net", "network, dns, public ip, tailscale"),
                ("fix", "repair network, dns, tailscale, ddns, traefik, dokploy, adguard, docker"),
                ("graph", "chart: cpu, mem, temp, net, disk"), ("jobs", "scheduled jobs"), ("run", "run a job"),
                ("containers", "list containers"), ("logs", "container logs"), ("restart", "restart a container"),
                ("n8n", "workflows and recent runs"), ("space", "docker disk usage and cleanup"),
                ("reboot", "reboot the box"), ("sh", "run a root command (pin)"), ("digest", "send the digest now"),
                ("new", "fresh ai conversation"), ("help", "what i can do")]


def ask_confirm(thread, action, reply_to):
    action = {**action, "source": "command"}
    send(thread, f"⚠️ <b>{html_escape(describe(action))}</b>?", html=True, reply_to=reply_to,
         buttons=[[("✅ yes", {**action, "confirmed": True}), ("✖ cancel", "x:cancel")]])


def command(thread, text, message_id):
    parts = text.split(maxsplit=1)
    name = parts[0][1:].split("@")[0].lower()
    arg = parts[1].strip() if len(parts) > 1 else ""
    reply = lambda body, **kw: send(thread, body, reply_to=message_id, **kw)  # noqa: E731
    if name in ("help", "start"):
        reply(HELP, html=True)
    elif name == "status":
        reply(box_status(), buttons=[[("📈 cpu 24h", {"do": "chart", "arg": "cpu", "range": "24h"}),
                                      ("📈 mem 24h", {"do": "chart", "arg": "mem", "range": "24h"}),
                                      ("🤖 anything wrong?", {"do": "ask", "arg": "Check the whole box and tell me if anything needs attention."})]])
    elif name == "net":
        reply(net_status(), buttons=[[(f"🔧 {t}", {"do": "fix", "arg": t}) for t in ("network", "dns", "tailscale")],
                                     [(f"🔧 {t}", {"do": "fix", "arg": t}) for t in ("ddns", "traefik", "adguard")]])
    elif name == "fix":
        if arg not in FIXES:
            reply("which one?", buttons=[[(f"🔧 {t}", {"do": "fix", "arg": t}) for t in list(FIXES)[i:i + 3]]
                                         for i in range(0, len(FIXES), 3)])
        elif arg == "docker":
            ask_confirm(thread, {"do": "fix", "arg": arg}, message_id)
        else:
            run_action_async(thread, {"do": "fix", "arg": arg, "source": "command"}, message_id)
    elif name == "graph":
        bits = arg.split()
        png, summary = chart(bits[0] if bits else "cpu", bits[1] if len(bits) > 1 else "24h")
        reply(summary, photo=png) if png else reply(summary)
    elif name == "jobs":
        rows = [j for j in jobs() if j.get("runnable", True) and not j.get("planned")]
        reply(jobs_text(), buttons=[[(f"▶ {j['name'].removeprefix('keep-')}", {"do": "run", "arg": j["name"]})
                                     for j in rows[i:i + 3]] for i in range(0, min(len(rows), 15), 3)])
    elif name == "run":
        run_action_async(thread, {"do": "run", "arg": arg, "source": "command"}, message_id)
    elif name == "containers":
        reply(container_list(arg))
    elif name == "logs":
        bits = arg.split()
        if not bits:
            return reply("usage: /logs <container> [30m]")
        out, resolved = container_logs(bits[0], bits[1] if len(bits) > 1 else "30m", 2000)
        if resolved:
            reply(f"logs of {resolved}", document=(f"{resolved}.log", out.encode()))
        else:
            reply(out)
    elif name == "restart":
        row, error = find_container(arg)
        if error:
            return reply(error)
        run_action_async(thread, {"do": "restart", "arg": row["name"], "source": "command"}, message_id)
    elif name == "n8n":
        reply(clip(n8n_workflows(), 3000) + "\n\nlast runs:\n" + clip(n8n_executions(limit=12), 3000))
    elif name == "space":
        ai_async(thread, "Docker is using a lot of disk. Show me what's there and let me choose what to clean.", message_id)
    elif name == "reboot":
        send(thread, "reboot the box?", reply_to=message_id,
             buttons=[[("🔁 now", {"do": "reboot", "when": "now", "confirmed": True, "source": "command"}),
                       ("🌙 tonight 03:00", {"do": "reboot", "when": "tonight", "confirmed": True, "source": "command"}),
                       ("✖ cancel", "x:cancel")]])
    elif name == "sh":
        if not arg:
            return reply("usage: /sh <command>")
        action = {"do": "shell", "arg": arg, "pin": True, "confirmed": True, "source": "command", "once": True}
        aid = register(action)
        pin_prompt(thread, aid, message_id)
    elif name == "digest":
        threading.Thread(target=lambda: send_digest(force=True), daemon=True).start()
    elif name == "new":
        CONVERSATIONS.pop(thread, None)
        reply("fresh conversation. what's up?")
    else:
        ai_async(thread, text, message_id)


# ---------------------------------------------------------------- buttons, confirmation and pin

PIN_ENTRY = {}


def pin_locked():
    with LOCK:
        fails = [t for t in STATE.get("pin_fails", []) if t > time.time() - 3600]
        STATE["pin_fails"] = fails
    return len(fails) >= 3


def pin_prompt(thread, aid, reply_to=None, message_id=None):
    if pin_locked():
        return send(thread, "🔒 pin locked for an hour after 3 wrong tries.", reply_to=reply_to)
    entered = PIN_ENTRY.get(aid, "")
    action = STATE["actions"].get(aid, {})
    text = (f"🔐 <b>{html_escape(describe(action))}</b>\nenter pin  "
            + " ".join("●" if i < len(entered) else "○" for i in range(max(len(PIN), 4))))
    keys = [[{"text": d, "callback_data": f"p:{aid}:{d}"} for d in row] for row in ("123", "456", "789")]
    keys.append([{"text": "⌫", "callback_data": f"p:{aid}:b"}, {"text": "0", "callback_data": f"p:{aid}:0"},
                 {"text": "✓", "callback_data": f"p:{aid}:k"}])
    keys.append([{"text": "✖ cancel", "callback_data": "x:cancel"}])
    if message_id:
        try:
            tg("editMessageText", chat_id=CHAT, message_id=message_id, text=text, parse_mode="HTML",
               reply_markup={"inline_keyboard": keys})
        except TgError as error:
            if "not modified" not in str(error):
                raise
        return message_id
    return send(thread, text, html=True, reply_to=reply_to, markup={"inline_keyboard": keys})


def run_action_async(thread, action, reply_to=None, origin_message=None):
    def work():
        started = time.time()
        if action["do"] in ("restart", "fix", "cleanup", "reboot", "run", "tidy", "shell"):
            try:
                tg("sendChatAction", chat_id=CHAT, message_thread_id=thread, action="typing")
            except Exception:  # noqa: BLE001
                pass
        try:
            result = perform(action)
        except Exception as error:  # noqa: BLE001
            result = f"failed: {error}"
            log(traceback.format_exc())
        took = f"{time.time() - started:.1f}s"
        if action["do"] == "shell":
            out = f"$ {action['arg']}\n{result}"
            if len(out) > 3500:
                send(thread, f"$ {action['arg'][:200]}", document=("output.txt", out.encode()), reply_to=reply_to)
            else:
                send(thread, f"<pre>{html_escape(out)}</pre>", html=True, reply_to=reply_to)
        else:
            send(thread, f"{'✅' if not result.startswith(('failed', 'unknown', 'refused', 'no ')) else '⚠️'} "
                         f"{describe(action)}\n{result}", reply_to=reply_to)
        if origin_message and action.get("once"):
            try:
                tg("editMessageReplyMarkup", chat_id=CHAT, message_id=origin_message, reply_markup={"inline_keyboard": []})
            except TgError:
                pass
        where = topic_of(thread)
        log_action(f"🧾 {describe(action)[:300]}\nby {action.get('source', 'button')} in {where} · {took}\n→ {result.splitlines()[0][:200] if result else ''}")
        if action.get("source") == "ai" and thread in CONVERSATIONS:
            CONVERSATIONS[thread]["messages"].append(
                {"role": "user", "content": f"[system] the owner tapped the button; result of {describe(action)}: {clip(result, 1500)}"})
    threading.Thread(target=work, daemon=True).start()


def on_callback(query):
    answer = lambda text=None: tg("answerCallbackQuery", callback_query_id=query["id"], text=text)  # noqa: E731
    if query["from"]["id"] != OWNER:
        return answer("only the owner can use these")
    data = query.get("data", "")
    message = query.get("message") or {}
    thread = message.get("message_thread_id") or TOPIC_IDS.get("control")
    message_id = message.get("message_id")
    if data == "x:cancel":
        answer("cancelled")
        try:
            tg("editMessageReplyMarkup", chat_id=CHAT, message_id=message_id, reply_markup={"inline_keyboard": []})
            tg("setMessageReaction", chat_id=CHAT, message_id=message_id, reaction=[{"type": "emoji", "emoji": "👌"}])
        except TgError:
            pass
        return
    if data.startswith("c:"):
        _, cid, pick = data.split(":", 2)
        choice = CHOICES.get(cid)
        if not choice:
            return answer("that question expired, ask again")
        if pick == "x":
            CHOICES.pop(cid, None)
            answer("cancelled")
            tg("editMessageReplyMarkup", chat_id=CHAT, message_id=message_id, reply_markup={"inline_keyboard": []})
            return ai_async(thread, "[button] cancel — I don't want any of these.", message_id)
        if choice["multi"] and pick != "d":
            choice["picked"] ^= {int(pick)}
            answer()
            return tg("editMessageReplyMarkup", chat_id=CHAT, message_id=message_id, reply_markup=choice_markup(cid))
        picked = [choice["options"][i] for i in sorted(choice["picked"])] if pick == "d" else [choice["options"][int(pick)]]
        if not picked:
            return answer("pick at least one")
        CHOICES.pop(cid, None)
        answer("got it")
        try:
            tg("editMessageText", chat_id=CHAT, message_id=message_id, parse_mode="HTML",
               text=md_to_html(choice["question"]) + "\n\n→ " + html_escape(", ".join(picked)))
        except TgError:
            pass
        return ai_async(thread, "[button] I chose: " + "; ".join(picked), message_id)
    if data.startswith("p:"):
        _, aid, key = data.split(":", 2)
        if aid not in STATE["actions"]:
            return answer("expired")
        if pin_locked():
            return answer("pin locked for an hour")
        entered = PIN_ENTRY.get(aid, "")
        if key == "b":
            PIN_ENTRY[aid] = entered[:-1]
        elif key == "k":
            if PIN and hmac.compare_digest(entered, PIN):
                PIN_ENTRY.pop(aid, None)
                action = STATE["actions"].pop(aid)
                save_state()
                answer("ok")
                tg("editMessageText", chat_id=CHAT, message_id=message_id, parse_mode="HTML",
                   text=f"🔓 <b>{html_escape(describe(action))}</b>\nrunning…")
                return run_action_async(thread, action, message_id)
            PIN_ENTRY[aid] = ""
            with LOCK:
                STATE.setdefault("pin_fails", []).append(time.time())
            save_state()
            answer("wrong pin")
            if pin_locked():
                safe_send("alerts", "🔒 3 wrong pin entries; shell commands are locked for an hour.")
                return tg("editMessageReplyMarkup", chat_id=CHAT, message_id=message_id, reply_markup={"inline_keyboard": []})
            return pin_prompt(thread, aid, message_id=message_id)
        elif len(entered) < 12:
            PIN_ENTRY[aid] = entered + key
        answer()
        return pin_prompt(thread, aid, message_id=message_id)
    if not data.startswith("a:"):
        return answer()
    aid = data[2:]
    action = STATE["actions"].get(aid)
    if not action:
        return answer("this button expired")
    kind = action["do"]
    if kind == "chart":
        answer("drawing…")
        png, summary = chart(action["arg"], action.get("range", "24h"))
        return send(thread, summary, photo=png, reply_to=message_id) if png else send(thread, summary, reply_to=message_id)
    if kind == "logs":
        answer("fetching…")
        out, resolved = container_logs(action["arg"], action.get("since", "1h"), 1000)
        return send(thread, f"logs of {resolved or action['arg']}", document=("logs.txt", out.encode()), reply_to=message_id)
    if kind == "journal":
        answer("fetching…")
        out = host_logs(action["arg"], action.get("since", "1d"), 300)
        return send(thread, f"journal of {action['arg']}", document=(f"{action['arg']}.log", out.encode()), reply_to=message_id)
    if kind == "ask":
        answer("looking…")
        return ai_async(thread, action["arg"], message_id, context=(message.get("text") or message.get("caption")))
    if kind == "mute":
        with LOCK:
            STATE["mutes"][action["arg"]] = time.time() + action.get("seconds", 3600)
        save_state()
        return answer(f"muted for {ago(time.time() - action.get('seconds', 3600))}")
    if kind == "n8n_run":
        answer("loading…")
        return send(thread, n8n_execution(action["arg"]), reply_to=message_id)
    if action.get("pin"):
        answer()
        return pin_prompt(thread, aid, reply_to=message_id)
    if (f"{kind}:{action.get('arg')}" in HEAVY or kind in HEAVY) and not action.get("confirmed"):
        answer()
        return ask_confirm(thread, {k: v for k, v in action.items() if k != "at"}, message_id)
    answer("on it")
    if action.get("once"):
        STATE["actions"].pop(aid, None)
        save_state()
    run_action_async(thread, {**action, "source": action.get("source", "button")}, message_id, message_id)


def on_message(message):
    if message.get("chat", {}).get("id") != CHAT or (message.get("from") or {}).get("id") != OWNER:
        return
    text = message.get("text") or message.get("caption") or ""
    thread = message.get("message_thread_id") or TOPIC_IDS.get("control")
    if message.get("is_topic_message") is not True and not message.get("message_thread_id"):
        thread = TOPIC_IDS.get("control")
    if PIN and re.search(rf"(?<!\d){re.escape(PIN)}(?!\d)", text):
        try:
            tg("deleteMessage", chat_id=CHAT, message_id=message["message_id"])
        except TgError:
            pass
        send(thread, "🔐 deleted your message: it contained the pin. the pin only goes on the keypad.")
        log_action("🧾 deleted a message that contained the pin")
        return
    if not text.strip():
        return
    if text.startswith("/"):
        try:
            command(thread, text.strip(), message["message_id"])
        except Exception as error:  # noqa: BLE001
            log(traceback.format_exc())
            safe_send(thread, f"command failed: {error}", reply_to=message["message_id"])
        return
    replied = message.get("reply_to_message") or {}
    context = None
    if replied and replied.get("message_id") != thread and (replied.get("from") or {}).get("is_bot"):
        context = replied.get("text") or replied.get("caption")
    ai_async(thread, text, message["message_id"], context)


# ---------------------------------------------------------------- outbox: messages from other scripts and the dashboard


def outbox_action(spec):
    """Buttons other scripts may attach. Anything that changes the box still runs only on a tap."""
    kind, _, rest = spec.partition(":")
    if kind in ("restart", "run", "logs", "journal", "fix", "chart"):
        arg, _, extra = rest.partition(":")
        return {"do": kind, "arg": arg, **({"range": extra} if kind == "chart" and extra else {})}
    if kind == "why":
        return {"do": "ask", "arg": rest or "Investigate this alert: what happened, why, and what should I do?"}
    if kind == "mute":
        key, _, seconds = rest.rpartition(":")
        return {"do": "mute", "arg": key, "seconds": int(seconds or 3600)}
    if kind in ("reboot", "tidy"):
        return {"do": kind}
    return None


def handle_outbox():
    """<KEEP_DATA>/outbox/<anything>.json: {"topic": "alerts", "text": "...", "key": "site:example.com" (edit the
    earlier message with that key), "silent": bool, "html": bool, "chart": "cpu:1h",
    "buttons": [["label", "restart:<container>" | "run:<job>" | "logs:<container>" | "why" | "mute:<key>:<sec>"]]}"""
    try:
        names = sorted(n for n in os.listdir(OUTBOX) if n.endswith(".json"))
    except OSError:
        return
    for name in names:
        path = f"{OUTBOX}/{name}"
        try:
            item = json.load(open(path))
        except (OSError, ValueError):
            os.remove(path)
            continue
        rows, row = [], []
        for label, spec in item.get("buttons") or []:
            action = outbox_action(spec)
            if action:
                row.append((label, action))
            if len(row) == 3:
                rows.append(row)
                row = []
        if row:
            rows.append(row)
        if item.get("why", True) and item.get("topic", "alerts") == "alerts" and not item.get("resolved"):
            rows.append([("🤖 why?", {"do": "ask", "arg": "Investigate this alert: what happened, why, and what should I do?"})])
        photo = None
        if item.get("chart"):
            metric, _, rng = str(item["chart"]).partition(":")
            photo, _ = chart(metric, rng or "1h")
        try:
            send(item.get("topic") if item.get("topic") in TOPICS else "alerts", str(item.get("text", ""))[:3900],
                 key=item.get("key"), silent=item.get("silent"), html=bool(item.get("html")),
                 buttons=rows or None, photo=photo)
            if item.get("resolved") and item.get("key"):
                with LOCK:
                    STATE["messages"].pop(item["key"], None)
            os.remove(path)
        except TgError as error:
            log("outbox send failed:", name, error)
            if time.time() - os.path.getmtime(path) > 86400:
                os.remove(path)
        except OSError as error:
            log("outbox: offline?", error)
            return


# ---------------------------------------------------------------- watchers


def hc_ping(slug, ok=True):
    key = ENV.get("HC_PING_KEY")
    if not key:
        return
    try:
        https("GET", f"https://hc-ping.com/{key}/{slug}{'' if ok else '/fail'}?create=1", timeout=10)
    except OSError as error:
        log("healthchecks ping failed:", error)


def watch_kuma():
    monitors = kuma_monitors()
    if monitors is None:
        return
    seen = STATE["seen"].setdefault("kuma", {})
    for mid, monitor in monitors.items():
        prev = seen.get(mid, {"status": 1, "fails": 0})
        fails = prev["fails"] + 1 if monitor["status"] == 0 else 0
        key = f"kuma:{mid}"
        if fails == 2:
            since = time.time() - 120
            send("alerts", f"🔴 {monitor['name']} is down\n{monitor['url']}\nsince {local(since)}", key=key,
                 photo=chart(f"kuma:{mid}:ms", "6h")[0] if f"kuma:{mid}:ms" in history_keys() else None,
                 buttons=[[("🤖 why?", {"do": "ask", "arg": f"Uptime Kuma monitor '{monitor['name']}' ({monitor['url']}) is down. Find out why and what to do."}),
                           ("🔕 mute 1h", {"do": "mute", "arg": key, "seconds": 3600})]]
                 + ([[("open kuma", "url:" + ENV["KUMA_PUBLIC_URL"])]] if ENV.get("KUMA_PUBLIC_URL") else []))
            prev["down_at"] = since
        elif fails == 0 and prev.get("fails", 0) >= 2:
            took = ago(prev.get("down_at", time.time()))
            message_id = send("alerts", f"🟢 {monitor['name']} is back · was down {took}\n{monitor['url']}", key=key)
            safe_send("alerts", f"🟢 {monitor['name']} back after {took}", silent=True, reply_to=message_id)
            with LOCK:
                STATE["messages"].pop(key, None)
        seen[mid] = {"status": monitor["status"], "fails": fails, **({"down_at": prev["down_at"]} if "down_at" in prev and fails else {})}


SWARM_TASK = re.compile(r"\.\d+\.[a-z0-9]{25}$")


def watch_containers():
    rows = containers()
    if not rows:
        return
    seen = STATE["seen"].setdefault("containers", {})
    first = not seen
    restarted = STATE["seen"].setdefault("auto_restarted", {})
    current = {}
    for r in rows:
        name = r["name"]
        problem = None
        if r["state"] == "restarting":
            problem = "keeps restarting (crash loop)"
        elif r["unhealthy"]:
            problem = "is unhealthy"
        elif r["state"] == "exited" and r["exit"] not in (None, 0, 137, 143) and seen.get(name) == "running" \
                and not SWARM_TASK.search(name):
            problem = f"crashed (exit {r['exit']})"
        current[name] = r["state"] if not problem else "problem"
        key = f"container:{name}"
        if problem and seen.get(name) != "problem" and not first:
            text = f"🔴 {name} {problem}\n{r['status']} · {r['image'].split('@')[0][:60]}"
            if problem.startswith("crashed") and time.time() - restarted.get(name, 0) > 6 * 3600:
                restarted[name] = time.time()
                result = perform({"do": "restart", "arg": name})
                text += f"\nauto-restarted once: {result}"
                log_action(f"🧾 auto-restart {name} after it crashed (exit {r['exit']}) → {result}")
            send("alerts", text, key=key, buttons=[
                [("📜 logs", {"do": "logs", "arg": name}), ("🔁 restart", {"do": "restart", "arg": name}),
                 ("🤖 why?", {"do": "ask", "arg": f"Container {name} {problem}. Look at its logs and the host and tell me why and what to do."})],
                [("🔕 mute 6h", {"do": "mute", "arg": key, "seconds": 6 * 3600})]])
        elif not problem and seen.get(name) == "problem":
            if key in STATE["messages"]:
                send("alerts", f"🟢 {name} is fine again · {r['status']}", key=key)
                with LOCK:
                    STATE["messages"].pop(key, None)
    STATE["seen"]["containers"] = current


def watch_jobs():
    seen = STATE["seen"].setdefault("jobs", {})
    first = not seen
    for job in jobs():
        name, last, result = job["name"], job.get("lastRun"), job.get("lastResult")
        if not last or seen.get(name, {}).get("run") == last:
            continue
        prev = seen.get(name, {})
        seen[name] = {"run": last, "result": result}
        if first:
            continue
        frequent = bool(re.match(r"every \d+\s*(min|m)\b", job.get("schedule") or ""))
        took = f" · {job['durationSec']:.0f}s" if isinstance(job.get("durationSec"), (int, float)) else ""
        if (job.get("schedule") or "").startswith("daily") and name != "keep-heartbeat":
            hc_ping(name, result != "failed")
        key = f"job:{name}"
        if result == "failed" and (not frequent or prev.get("result") != "failed"):
            send("alerts", f"🔴 job {name} failed at {local(last)}\n{job.get('description', '')}", key=key, buttons=[
                [("📜 log", {"do": "journal", "arg": name, "since": "1d"}), ("▶ retry", {"do": "run", "arg": name}),
                 ("🤖 why?", {"do": "ask", "arg": f"The job {name} failed. Read its journal and tell me why and what to do."})]])
        elif result != "failed" and prev.get("result") == "failed" and key in STATE["messages"]:
            send("alerts", f"🟢 job {name} works again · {local(last)}", key=key)
            with LOCK:
                STATE["messages"].pop(key, None)
        if not frequent:
            safe_send("jobs", f"{'✅' if result != 'failed' else '❌'} {name} · {local(last)}{took}\n{job.get('description', '')}",
                      buttons=[[("📜 log", {"do": "journal", "arg": name, "since": "1d"})]])


ACTIVITY_ICONS = {"ssh": "🔑", "sudo": "⚡", "boot": "🔁", "login": "🔑", "deploy": "🚀", "cleanup": "🧹", "reboot": "🔁"}


def watch_activity():
    data = read_json(f"{DATA}/activity.json", {}) or {}
    events = data.get("events") or []
    last = STATE["seen"].get("activity_at")
    if last is None:
        STATE["seen"]["activity_at"] = max((e.get("at", 0) for e in events), default=time.time())
        STATE["seen"]["devices"] = sorted(d.get("name") for d in data.get("devices") or [])
        return
    fresh = [e for e in events if e.get("at", 0) > last]
    if fresh:
        STATE["seen"]["activity_at"] = max(e["at"] for e in fresh)
        lines = []
        for e in fresh[-25:]:
            who = " · ".join(str(x) for x in (e.get("user"), e.get("source")) if x)
            lines.append(f"{ACTIVITY_ICONS.get(e.get('kind'), '•')} {local(e['at'])} {e.get('kind')}"
                         + (f" · {who}" if who else "") + (f"\n   {str(e.get('detail'))[:160]}" if e.get("detail") else ""))
        safe_send("access", "\n".join(lines))
    devices = sorted(d.get("name") for d in data.get("devices") or [] if d.get("name"))
    new = [d for d in devices if d not in STATE["seen"].get("devices", [])]
    if new and STATE["seen"].get("devices"):
        safe_send("access", "📱 new device on the tailnet: " + ", ".join(new), silent=False)
    STATE["seen"]["devices"] = devices


def watch_n8n():
    if not n8n_db():
        return
    since = STATE["seen"].get("n8n_at") or datetime.now(timezone.utc).isoformat()
    rows = n8n_query(f"""SELECT coalesce(json_agg(x ORDER BY x."startedAt"), '[]') FROM (
        SELECT e.id, w.name AS workflow, e.status, e."startedAt" FROM execution_entity e
        LEFT JOIN workflow_entity w ON w.id = e."workflowId"
        WHERE e.status IN ('error', 'crashed') AND e."startedAt" > {sql_text(since)}::timestamptz) x""") or []
    STATE["seen"]["n8n_at"] = rows[-1]["startedAt"] if rows else (STATE["seen"].get("n8n_at") or since)
    for r in rows[-5:]:
        detail = n8n_execution(r["id"])
        error = next((l for l in detail.splitlines() if "error" in l.lower()), "")
        send("alerts", f"🔴 n8n: {r['workflow']} failed (run #{r['id']})\n{error[:300]}", buttons=[
            [("🔎 run details", {"do": "n8n_run", "arg": str(r["id"])}),
             ("📜 n8n logs", {"do": "logs", "arg": "n8n", "since": "1h"}),
             ("🤖 why?", {"do": "ask", "arg": f"n8n run #{r['id']} of '{r['workflow']}' failed. Look at the run and n8n's logs and explain what went wrong and how to fix it."})]])


def apt_upgradable():
    code, out = run(["apt", "list", "--upgradable"], 60)
    return [l.split("/")[0] for l in out.splitlines() if "/" in l and "upgradable" in l]


def send_digest(force=False):
    now = datetime.now(TZ)
    at = ENV.get("DIGEST_AT", "08:00")
    today = now.strftime("%Y-%m-%d")
    if not force and (now.strftime("%H:%M") < at or STATE["seen"].get("digest_day") == today):
        return
    STATE["seen"]["digest_day"] = today
    save_state()
    lines = [f"☀️ {now.strftime('%A %b %d')}"]
    uptime = float(open("/proc/uptime").read().split()[0])
    lines.append(f"up {ago(time.time() - uptime)} · cpu avg {fmt_value(avg_of('cpu', 86400), 'pct')} · "
                 f"memory {fmt_value(latest('mem'), 'pct')} · temp peak {fmt_value(peak_of('temp:cpu:package', 86400), 'temp')}")
    for path, used, total in mounts():
        lines.append(f"{path}: {used / total * 100:.0f}% ({human_bytes(total - used)} free)")
    monitors = kuma_monitors() or {}
    down = [m["name"] for m in monitors.values() if m["status"] == 0]
    if monitors:
        lines.append(f"sites: {len(monitors) - len(down)}/{len(monitors)} up" + (f" · down: {', '.join(down)}" if down else ""))
    rows = containers()
    bad = [r["name"] for r in rows if r["state"] == "restarting" or r["unhealthy"]]
    lines.append(f"containers: {sum(r['state'] == 'running' for r in rows)} running" + (f" · trouble: {', '.join(bad)}" if bad else ""))
    day_ago = time.time() - 86400
    ran = [j for j in jobs() if (j.get("lastRun") or 0) > day_ago]
    failed = [j["name"] for j in ran if j.get("lastResult") == "failed"]
    lines.append(f"jobs: {len(ran)} ran in 24h" + (f" · failed: {', '.join(failed)}" if failed else ", all fine"))
    try:
        n8n = n8n_query("""SELECT json_build_object('runs', count(*), 'failed', count(*) FILTER (WHERE status IN ('error','crashed')))
                           FROM execution_entity WHERE "startedAt" > now() - interval '24 hours'""")
        lines.append(f"n8n: {n8n['runs']} runs, {n8n['failed']} failed")
    except Exception:  # noqa: BLE001
        pass
    upgradable = apt_upgradable()
    if upgradable:
        lines.append(f"updates: {len(upgradable)} packages upgradable")
    if os.path.exists("/var/run/reboot-required"):
        lines.append("🔁 reboot required for updates")
    yesterday = datetime.fromtimestamp(time.time() - 86400, TZ).strftime("%Y-%m-%d")
    tokens = STATE.get("ai_tokens", {}).get(yesterday)
    if tokens:
        lines.append(f"ai: {tokens:,} tokens yesterday")
    png, _ = render_chart("last 24h", [("cpu", "cpu"), ("memory", "mem")], 86400)
    previous = STATE["seen"].get("digest_message")
    message_id = send("digest", "\n".join(lines), photo=png, buttons=[
        [("📈 temps 7d", {"do": "chart", "arg": "temp", "range": "7d"}), ("📈 disk 30d", {"do": "chart", "arg": "disk", "range": "30d"}),
         ("🤖 anything to do?", {"do": "ask", "arg": "Look at today's digest and the box. Is there anything I should do today?"})]])
    try:
        if previous:
            tg("unpinChatMessage", chat_id=CHAT, message_id=previous)
        tg("pinChatMessage", chat_id=CHAT, message_id=message_id, disable_notification=True)
    except TgError as error:
        log("pin failed:", error)
    STATE["seen"]["digest_message"] = message_id
    save_state()


def avg_of(key, seconds):
    rows = history(key, seconds)
    return sum(r[1] for r in rows) / len(rows) if rows else None


def peak_of(key, seconds):
    rows = history(key, seconds)
    return max(r[2] for r in rows) if rows else None


def watchdog():
    """Fix the network ourselves when it's gone: nobody can reach the box to do it."""
    offline_since, did_network = None, False
    while True:
        time.sleep(30)
        try:
            if online():
                if offline_since and time.time() - offline_since > 60:
                    note = f"🟢 back online · was offline {ago(offline_since)}" + (" · re-applied the network config" if did_network else "")
                    with LOCK:
                        STATE["pending_notes"] = STATE.get("pending_notes", []) + [note]
                    save_state()
                offline_since, did_network = None, False
                continue
            offline_since = offline_since or time.time()
            down = time.time() - offline_since
            if down > 300 and not did_network:
                did_network = True
                log("watchdog: offline 5m, re-applying network")
                iface = default_iface()[0] or ENV.get("NET_IFACE", "enp5s0")
                run(["networkctl", "reconfigure", iface], 60)
                run(["resolvectl", "flush-caches"])
            if down > 900:
                last = STATE.get("watchdog_reboot", 0)
                uptime = float(open("/proc/uptime").read().split()[0])
                if time.time() - last > 3600 and uptime > 1200:
                    log("watchdog: offline 15m, rebooting")
                    with LOCK:
                        STATE["watchdog_reboot"] = time.time()
                        STATE["reboot_note"] = {"at": time.time(), "by": f"watchdog after {ago(offline_since)} offline"}
                    save_state()
                    run(["systemctl", "reboot"])
        except Exception:  # noqa: BLE001
            log("watchdog error:", traceback.format_exc())


def watchers():
    tick = 0
    while True:
        for name, fn, every in (("kuma", watch_kuma, 1), ("containers", watch_containers, 1), ("jobs", watch_jobs, 1),
                                ("activity", watch_activity, 1), ("n8n", watch_n8n, 2), ("digest", send_digest, 1)):
            if tick % every:
                continue
            try:
                fn()
            except Exception:  # noqa: BLE001 - one broken watcher must not stop the others
                log(f"watcher {name} failed:", traceback.format_exc().splitlines()[-1])
        notes = STATE.pop("pending_notes", [])
        for note in notes:
            safe_send("alerts", note, silent=True)
        save_state()
        tick += 1
        time.sleep(60)


def outbox_loop():
    os.makedirs(OUTBOX, exist_ok=True)
    try:
        parent = os.stat(DATA)
        os.chown(OUTBOX, parent.st_uid, parent.st_gid)
        os.chmod(OUTBOX, 0o770)
    except OSError:
        pass
    while True:
        try:
            handle_outbox()
        except Exception:  # noqa: BLE001
            log("outbox error:", traceback.format_exc().splitlines()[-1])
        time.sleep(2)


def startup_notes():
    uptime = float(open("/proc/uptime").read().split()[0])
    note = STATE.pop("reboot_note", None)
    if note and uptime < 1800:
        safe_send("updates", f"🔁 back after reboot ({note['by']}) · booted {local(time.time() - uptime)}")
    elif uptime < 600:
        upgrade = read_json(f"{DATA}/upgrade-state.json", {}) or {}
        why = " for updates" if upgrade.get("rebooted") == datetime.now(timezone.utc).strftime("%Y-%m-%d") else ""
        safe_send("updates", f"🔁 the box booted{why} at {local(time.time() - uptime)}")
    save_state()


def main():
    global BOT_NAME
    if not (TOKEN and CHAT and OWNER):
        sys.exit("TELEGRAM_TOKEN, TELEGRAM_CHAT and TELEGRAM_OWNER must be set in /etc/keep/bot.env")
    sys.setrecursionlimit(20000)
    load_state()
    while True:
        try:
            BOT_NAME = tg("getMe")["username"]
            ensure_topics()
            tg("setMyCommands", commands=[{"command": c, "description": d} for c, d in BOT_COMMANDS])
            break
        except (OSError, TgError) as error:
            log("startup waiting for telegram:", error)
            time.sleep(15)
    log(f"@{BOT_NAME} up, topics {TOPIC_IDS}")
    startup_notes()
    for target in (watchers, watchdog, outbox_loop):
        threading.Thread(target=target, daemon=True).start()
    offset = STATE.get("offset", 0)
    while True:
        try:
            updates = tg("getUpdates", offset=offset, timeout=50, allowed_updates=["message", "callback_query"])
        except (OSError, TgError, ValueError) as error:
            log("poll failed:", error)
            time.sleep(5)
            continue
        for update in updates:
            offset = update["update_id"] + 1
            try:
                if "callback_query" in update:
                    on_callback(update["callback_query"])
                elif "message" in update:
                    on_message(update["message"])
            except Exception:  # noqa: BLE001
                log("update failed:", traceback.format_exc())
        if updates:
            with LOCK:
                STATE["offset"] = offset
            save_state()


if __name__ == "__main__":
    main()
