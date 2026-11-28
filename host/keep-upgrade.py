#!/usr/bin/env python3
"""Monthly unattended-upgrades check + reboot if needed.

Runs from keep-upgrade.service, triggered by keep-upgrade.timer (first Sunday
after keep-tidy). If /var/run/reboot-required exists, ntfy before and after,
then reboot. Never reboots twice in one day.
"""

import json
import os
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone

REBOOT_REQUIRED = "/var/run/reboot-required"
STATE = "/srv/keep-dashboard/upgrade-state.json"
NTFY_TOPIC_FILE = "/srv/uptime-kuma/admin.env"
OUTBOX = "/srv/keep-dashboard/outbox"


def notify(title, message, priority=3):
    try:
        topic = dict(line.split("=", 1) for line in open(NTFY_TOPIC_FILE).read().split())["NTFY_TOPIC"]
        request = urllib.request.Request(
            f"https://ntfy.sh/{topic}",
            data=message.encode(),
            method="POST",
            headers={"Title": title, "Priority": str(priority), "Tags": "gear"},
        )
        urllib.request.urlopen(request, timeout=10)
    except Exception as error:
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


def load_state():
    try:
        return json.load(open(STATE))
    except (OSError, ValueError):
        return {}


def save_state(state):
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    with open(f"{STATE}.tmp", "w") as handle:
        json.dump(state, handle)
    os.replace(f"{STATE}.tmp", STATE)


def main():
    state = load_state()
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    if state.get("rebooted") == today:
        print("already rebooted today")
        return

    if not os.path.exists(REBOOT_REQUIRED):
        print("no reboot required")
        state.pop("rebooted", None)
        save_state(state)
        return

    notify("the-keep: rebooting for updates", "a new kernel or critical update requires a reboot; starting now", priority=4)
    telegram("🔁 rebooting for updates: a new kernel or critical update needs it", topic="updates")
    time.sleep(3)  # let keep-bot post it before the network goes down
    save_state({"rebooted": today, "at": datetime.now(timezone.utc).isoformat(timespec="seconds")})
    subprocess.run(["systemctl", "reboot"])


if __name__ == "__main__":
    main()
