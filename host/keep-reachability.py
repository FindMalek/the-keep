#!/usr/bin/env python3
"""Checks every public site the way a visitor on another network reaches it.

Runs from keep-reachability.timer every 5 minutes. For each public (not tailnet-only) Traefik host it resolves
the name through public DNS (Cloudflare DoH, never AdGuard's tailnet rewrite) and fetches it over HTTPS at that
address. It also checks that home.findmalek.engineer still points at the box's current public IP.

Writes reachability.json (latest result), appends every change to reachability.log (one JSON line each) and
pushes changes to ntfy.sh. A site counts as down after failing two runs in a row. Exits 1 while anything is down,
so the jobs page shows it red. The external GitHub check (.github/workflows/reachability.yml) covers the case
where this box itself is down.
"""

import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

DATA = "/srv/keep-dashboard"
HOME = "home.findmalek.engineer"
DOMAIN = "findmalek.engineer"
NTFY_ENV = "/srv/uptime-kuma/admin.env"
OUTBOX = f"{DATA}/outbox"
FAILS_TO_ALERT = 2


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def get(url, timeout=10, headers=None):
    request = urllib.request.Request(url, headers={"user-agent": "keep-reachability", **(headers or {})})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read().decode()


def public_ip():
    for url in ("https://api.ipify.org", "https://ifconfig.me/ip", "https://icanhazip.com"):
        try:
            return get(url).strip()
        except OSError:
            continue
    return None


def resolve(name):
    """A record via Cloudflare DoH, following CNAMEs; None if it does not resolve."""
    try:
        answer = json.loads(get(f"https://cloudflare-dns.com/dns-query?name={name}&type=A",
                                headers={"accept": "application/dns-json"})).get("Answer") or []
    except (OSError, ValueError):
        return None
    ips = [a["data"] for a in answer if a.get("type") == 1]
    return ips[0] if ips else None


def public_hosts():
    out = subprocess.run(["docker", "exec", "dokploy-traefik", "wget", "-qO-",
                          "http://localhost:8080/api/http/routers?per_page=1000"],
                         capture_output=True, text=True, timeout=30).stdout
    public, private = set(), set()
    for router in json.loads(out or "[]"):
        hosts = {h for h in re.findall(r"Host\(`([^`]+)`\)", router.get("rule", "")) if h.endswith(DOMAIN)}
        tailnet = any("tailnet-only" in m for m in router.get("middlewares") or [])
        (private if tailnet else public).update(hosts)
    return sorted(public - private)


def check(host, box_ip):
    ip = resolve(host)
    if not ip:
        return {"host": host, "ok": False, "ip": None, "code": 0, "ms": None, "error": "no public dns"}
    if box_ip and ip != box_ip:
        # The findmalek.engineer wildcard sends names without their own record to Vercel, which answers 404.
        return {"host": host, "ok": False, "ip": ip, "code": 0, "ms": None, "error": f"dns points to {ip}, not the box"}
    result = subprocess.run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code} %{time_total}", "--max-time", "10",
                             "--retry", "1", "--resolve", f"{host}:443:{ip}", f"https://{host}/"],
                            capture_output=True, text=True)
    code, seconds = (result.stdout.split() + ["0", "0"])[:2]
    code = int(code) if code.isdigit() else 0
    error = None if 0 < code < 500 else (f"http {code}" if code else f"no connection (curl {result.returncode})")
    return {"host": host, "ok": error is None, "ip": ip, "code": code, "ms": round(float(seconds) * 1000), "error": error}


def notify(text):
    try:
        env = dict(line.split("=", 1) for line in open(NTFY_ENV).read().split() if "=" in line)
        request = urllib.request.Request(f"https://ntfy.sh/{env['NTFY_TOPIC']}", data=text.encode(), method="POST",
                                         headers={"title": "the-keep reachability", "tags": "globe_with_meridians"})
        urllib.request.urlopen(request, timeout=10).close()
    except (OSError, KeyError, ValueError) as error:
        print(f"ntfy failed: {error}", file=sys.stderr)


def telegram(text, key=None, topic="alerts", resolved=False):
    """Hand a message to keep-bot (host/keep-bot.py), which posts it to the Telegram group; same key edits it."""
    try:
        os.makedirs(OUTBOX, exist_ok=True)
        path = f"{OUTBOX}/{time.time_ns()}.json"
        with open(f"{path}.tmp", "w") as handle:
            json.dump({"topic": topic, "text": text, "key": key, "resolved": resolved}, handle)
        os.replace(f"{path}.tmp", path)
    except OSError as error:
        print(f"telegram outbox failed: {error}", file=sys.stderr)


def main():
    try:
        previous = json.load(open(f"{DATA}/reachability.json"))
    except (OSError, ValueError):
        previous = {}
    fails = previous.get("fails", {})

    ip, home_ip = public_ip(), resolve(HOME)
    with ThreadPoolExecutor(8) as pool:
        sites = list(pool.map(lambda host: check(host, home_ip), public_hosts()))

    checks = {s["host"]: s for s in sites}
    checks[HOME] = {"host": HOME, "ok": bool(ip) and ip == home_ip, "ip": home_ip, "code": None, "ms": None,
                    "error": None if ip and ip == home_ip else f"dns says {home_ip}, box is at {ip}"}
    fails = {host: (fails.get(host, 0) + 1 if not c["ok"] else 0) for host, c in checks.items()}
    down = sorted(h for h, n in fails.items() if n >= FAILS_TO_ALERT)
    was_down = set(previous.get("down", []))

    changes = [f"down: {h} ({checks[h]['error']})" for h in down if h not in was_down]
    changes += [f"back up: {h}" for h in sorted(was_down - set(down)) if h in checks]
    if changes:
        with open(f"{DATA}/reachability.log", "a") as log:
            for change in changes:
                log.write(json.dumps({"at": now(), "event": change}) + "\n")
        if previous:
            notify("\n".join(changes))
            for host in down:
                if host not in was_down:
                    telegram(f"🔴 {host} is unreachable from outside\n{checks[host]['error']}", f"site:{host}")
            for host in sorted(was_down - set(down)):
                telegram(f"🟢 {host} is reachable again", f"site:{host}", resolved=True)
    for change in changes:
        print(change)

    json.dump({"at": now(), "publicIp": ip, "homeDns": home_ip, "down": down, "fails": fails, "sites": sites},
              open(f"{DATA}/reachability.json", "w"), indent=1)
    print(f"{len(sites) - sum(not s['ok'] for s in sites)}/{len(sites)} sites reachable, public ip {ip}, dns {home_ip}")
    sys.exit(1 if down else 0)


if __name__ == "__main__":
    main()
