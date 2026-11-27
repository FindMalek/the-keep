#!/usr/bin/env python3
"""Guard for disks, drive health and backups. ntfy on each problem, again once a day while it lasts.

- a disk at 75% (90% is urgent); a full / or /srv also starts keep-tidy, at most every 6h
- no local backup snapshot in 36h, or the backup HDD not mounted
- the backup grew more than 100 GB, or /srv more than 50 GB, in a day: something new is being kept
- SSD writes over the daily budget, SSD life under 80%, HDD bad sectors, heat or head parking
- an app that keeps failing (Swarm service at 0 running, or a container restarting) is stopped and reported

It also holds the docker build cache to 75 GB and writes journal.json (log volume per hour, top writers) for the dashboard. Runs every 15 minutes.

The backup HDD is never woken for this: its usage comes from statvfs, its SMART only when it is spinning, and
backup freshness from the dashboard's backrest-status.json.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request

LIMIT_PCT, URGENT_PCT = 75, 90
DISKS = ("/", "/srv", "/srv/backup-hdd")
BACKUP_DISK = "/srv/backup-hdd"
BACKUP_STATUS = "/srv/keep-dashboard/backrest-status.json"
STALE_BACKUP_SEC = 36 * 3600
DAILY_GROWTH_GB = {"/srv/backup-hdd": 100, "/srv": 50}
# GB written per day before it counts as wear worth a look (sdb is the small OS SSD).
WRITE_BUDGET_GB = {"sda": 200, "sdb": 40}
MIN_SSD_LIFE_PCT = 80
HDD_MAX_TEMP_C = 50
HDD_MAX_LOAD_CYCLES_PER_DAY = 300
REPEAT_SEC = 86400
TIDY_EVERY_SEC = 6 * 3600
STATE = "/srv/keep-dashboard/disk-watch.json"
JOURNAL_OUT = "/srv/keep-dashboard/journal.json"
# BuildKit counts less than `docker system df` shows (~8 GB less here); 65gb keeps the reported total under 75 GB.
BUILD_CACHE_CAP = "65gb"
NTFY_TOPIC_FILE = "/srv/uptime-kuma/admin.env"


def notify(message, priority):
    try:
        topic = dict(line.split("=", 1) for line in open(NTFY_TOPIC_FILE).read().split())["NTFY_TOPIC"]
        request = urllib.request.Request(
            f"https://ntfy.sh/{topic}",
            data=message.encode(),
            method="POST",
            headers={"Title": "the-keep: storage", "Priority": str(priority), "Tags": "floppy_disk"},
        )
        urllib.request.urlopen(request, timeout=10)
        return True
    except Exception as error:
        print(f"ntfy failed: {error}", file=sys.stderr)
        return False


def run(*args):
    return subprocess.run(args, capture_output=True, text=True).stdout


def smart(device):
    # -n standby: skip a sleeping HDD instead of spinning it up. Raw values by attribute id.
    values = {}
    for line in run("smartctl", "-n", "standby", "-A", f"/dev/{device}").splitlines():
        parts = line.split()
        if len(parts) >= 10 and parts[0].isdigit() and (raw := re.match(r"\d+", parts[9])):
            values[int(parts[0])] = int(raw[0])
    return values


def daily_delta(marks, key, value, now):
    """Change of `value` over the last full day, or None until a day has passed."""
    mark = marks.get(key)
    if not mark or now - mark["at"] >= 86400:
        if mark:
            marks[f"{key}:delta"] = {"at": now, "value": (value - mark["value"]) * 86400 / (now - mark["at"])}
        marks[key] = {"at": now, "value": value}
    delta = marks.get(f"{key}:delta")
    return delta["value"] if delta and now - delta["at"] < 86400 else None


def check_space(state, found, now):
    marks = state.setdefault("marks", {})
    for path in DISKS:
        if path != "/" and not os.path.ismount(path):
            found[path] = (f"{path} is not mounted", 5)
            continue
        usage = shutil.disk_usage(path)
        pct = 100 * usage.used / (usage.used + usage.free)
        if pct >= LIMIT_PCT:
            found[path] = (f"{path} is {pct:.0f}% full, {usage.free / 1e9:.0f} GB left", 5 if pct >= URGENT_PCT else 4)
        grown = daily_delta(marks, f"used:{path}", usage.used / 1e9, now)
        if path in DAILY_GROWTH_GB and grown and grown > DAILY_GROWTH_GB[path]:
            found[f"growth:{path}"] = (f"{path} grew {grown:.0f} GB in a day; check what started being kept", 4)


def check_backup(found, now):
    if not os.path.ismount(BACKUP_DISK):
        return
    try:
        newest = max(item["at"] for item in json.load(open(BACKUP_STATUS)).get("snapshots") or []) / 1000
    except (OSError, ValueError, KeyError):
        newest = 0
    if now - newest > STALE_BACKUP_SEC:
        found["backup"] = ("no local backup snapshot in the last 36h", 5)


def check_drives(state, found, now):
    marks = state.setdefault("marks", {})
    for device, budget in WRITE_BUDGET_GB.items():
        values = smart(device)
        if values.get(231) is not None and values[231] < MIN_SSD_LIFE_PCT:
            found[f"life:{device}"] = (f"{device} SSD life is down to {values[231]}%", 4)
        # attribute 241 counts GB on these Team SSDs
        per_day = daily_delta(marks, f"written:{device}", values[241], now) if 241 in values else None
        if per_day and per_day > budget:
            found[f"writes:{device}"] = (f"{device} took {per_day:.0f} GB of writes in a day (budget {budget})", 3)
    hdd = smart("sdc")
    if not hdd:
        return
    if bad := hdd.get(5, 0) + hdd.get(197, 0) + hdd.get(198, 0):
        found["hdd:sectors"] = (f"backup HDD has {bad} reallocated/pending/uncorrectable sectors", 5)
    if hdd.get(194, 0) > HDD_MAX_TEMP_C:
        found["hdd:temp"] = (f"backup HDD is at {hdd[194]} °C", 4)
    cycles = daily_delta(marks, "cycles:sdc", hdd.get(193, 0), now)
    if cycles and cycles > HDD_MAX_LOAD_CYCLES_PER_DAY:
        found["hdd:cycles"] = (f"backup HDD parked its heads {cycles:.0f} times in a day; check spin-down", 3)


def check_crash_loops(state, found):
    # Every retry of a failing app is a new container: log spam, disk writes, leftover volumes. Two checks in a
    # row (15-30 min) failing means it won't fix itself, so it is stopped and reported; a redeploy starts it
    # again. Dokploy itself is never touched.
    down = []
    for line in run("docker", "service", "ls", "--format", "{{.Name}} {{.Replicas}}").splitlines():
        name, replicas = line.split()[:2]
        running, _, wanted = replicas.partition("/")
        if running == "0" and wanted.split()[0] != "0" and not name.startswith("dokploy"):
            down.append(name)
    for name in set(down) & set(state.get("down", [])):
        subprocess.run(["docker", "service", "scale", "-d", f"{name}=0"], capture_output=True)
        found[f"loop:{name}"] = (f"{name} kept failing to start, scaled it to 0 (redeploy to bring it back)", 4)
    state["down"] = down

    # Plain containers (compose) restart in place: compare restart counts between checks.
    restarts = {}
    for line in run("docker", "ps", "-a", "--filter", "status=restarting", "--filter", "status=running",
                    "--format", "{{.Names}}").split():
        if line.startswith("dokploy"):
            continue
        count = run("docker", "inspect", "-f", "{{.RestartCount}}", line).strip()
        if count.isdigit():
            restarts[line] = int(count)
    previous = state.get("restarts", {})
    for name, count in restarts.items():
        if count - previous.get(name, count) >= 3:
            subprocess.run(["docker", "update", "--restart=no", name], capture_output=True)
            subprocess.run(["docker", "stop", name], capture_output=True)
            found[f"loop:{name}"] = (f"{name} restarted {count - previous[name]} times in 15 min, stopped it", 4)
    state["restarts"] = restarts


def enforce_build_cache_cap():
    # BuildKit's own GC (daemon.json) only runs now and then and overshoots; this makes 75 GB a hard line,
    # least recently used first.
    subprocess.run(["docker", "builder", "prune", "--all", "--force", "--max-used-space", BUILD_CACHE_CAP],
                   capture_output=True)


def write_journal_summary():
    # For the dashboard's log panel: lines per hour over a day, by priority, and who writes the most.
    out = subprocess.run(["journalctl", "--since", "-24h", "-o", "json", "--no-pager",
                          "--output-fields=SYSLOG_IDENTIFIER,_COMM,PRIORITY"], capture_output=True, text=True).stdout
    now = time.time()
    hours = [{"at": int(now // 3600 * 3600 - 3600 * index), "lines": 0, "errors": 0, "warnings": 0} for index in range(23, -1, -1)]
    sources = {}
    for line in out.splitlines():
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        at = int(entry.get("__REALTIME_TIMESTAMP", 0)) / 1e6
        slot = int((at - hours[0]["at"]) // 3600)
        if not 0 <= slot < 24:
            continue
        priority = int(entry.get("PRIORITY", 6))
        hours[slot]["lines"] += 1
        hours[slot]["errors"] += priority <= 3
        hours[slot]["warnings"] += priority == 4
        if at > now - 3600:
            source = entry.get("SYSLOG_IDENTIFIER") or entry.get("_COMM") or "?"
            sources[source] = sources.get(source, 0) + 1
    usage = subprocess.run(["journalctl", "--disk-usage"], capture_output=True, text=True).stdout
    match = re.search(r"take up ([\d.]+)([KMGT])", usage)
    disk = float(match[1]) * {"K": 1e3, "M": 1e6, "G": 1e9, "T": 1e12}[match[2]] if match else None
    summary = {"at": int(now * 1000), "diskBytes": disk, "capBytes": 1e9, "hours": hours,
               "top": sorted(({"source": k, "lines": v} for k, v in sources.items()), key=lambda s: -s["lines"])[:8]}
    with open(f"{JOURNAL_OUT}.tmp", "w") as handle:
        json.dump(summary, handle)
    os.replace(f"{JOURNAL_OUT}.tmp", JOURNAL_OUT)


def main():
    try:
        with open(STATE) as handle:
            state = json.load(handle)
    except (OSError, ValueError):
        state = {}
    now = time.time()
    found = {}
    check_space(state, found, now)
    check_backup(found, now)
    check_drives(state, found, now)
    check_crash_loops(state, found)
    enforce_build_cache_cap()
    write_journal_summary()
    sent = state.get("sent", {})
    for key, (message, priority) in found.items():
        print(message)
        if now - sent.get(key, 0) >= REPEAT_SEC and notify(message, priority):
            sent[key] = now
    state["sent"] = {key: at for key, at in sent.items() if key in found}
    if ("/" in found or "/srv" in found) and now - state.get("tidied", 0) >= TIDY_EVERY_SEC:
        subprocess.run(["systemctl", "start", "--no-block", "keep-tidy.service"])
        state["tidied"] = now
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    with open(f"{STATE}.tmp", "w") as handle:
        json.dump(state, handle)
    os.replace(f"{STATE}.tmp", STATE)


if __name__ == "__main__":
    main()
