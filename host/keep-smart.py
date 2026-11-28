#!/usr/bin/env python3
"""Daily SMART check for the box's SSDs and backup HDD, with a year of daily wear and write history.

Runs from keep-smart.service / keep-smart.timer. Writes a JSON summary that the
dashboard reads to show disk wear and status.
"""

import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone

OUT = "/srv/keep-dashboard/smart.json"


def run(*args):
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"smartctl failed: {result.stderr.strip()}", file=sys.stderr)
    return result.stdout


def devices():
    """List ATA/SATA/NVMe devices from smartctl --scan."""
    out = run("smartctl", "--scan")
    for line in out.splitlines():
        parts = line.split()
        if not parts:
            continue
        path = parts[0]
        # Skip duplicates listed as /dev/sg*; keep block devices.
        if path.startswith("/dev/sg"):
            continue
        yield path


def attribute(out, name):
    """Row of `smartctl -A` for one attribute name: (normalized value, raw value), or None."""
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 10 and parts[1] == name and parts[0].isdigit():
            raw = re.match(r"\d+", parts[9])
            return (int(parts[3]), int(raw.group()) if raw else None)
    return None


def labelled(out, key):
    """NVMe style `Key:   value` lines; smartctl groups thousands with commas (`1,234`)."""
    for line in out.splitlines():
        if line.startswith(key):
            match = re.search(r"(\d[\d,]*)", line.split(":", 1)[1])
            if match:
                return int(match.group(1).replace(",", ""))
    return None


def health(path):
    out = run("smartctl", "-H", path)
    if "PASSED" in out:
        return "passed"
    if "FAILED" in out:
        return "failed"
    return "unknown"


def info(path):
    # -n standby: a sleeping HDD is skipped, not spun up; its last values are kept from the previous run.
    out = run("smartctl", "-n", "standby", "-A", path)
    if not out.strip() or "STANDBY" in out:
        return None
    raw = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 10 and parts[0].isdigit() and (number := re.match(r"\d+", parts[9])):
            raw[int(parts[0])] = (int(parts[3]), int(number.group()))
    wear = labelled(out, "Percentage Used")
    if wear is None:
        # SATA: the normalized value counts down from 100, so wear is what is gone. Team SSDs only expose
        # remaining life as raw attribute 231 (unnamed in smartctl's database).
        for name in ("Wear_Leveling_Count", "Media_Wearout_Indicator", "SSD_Life_Left", "Percent_Lifetime_Remain"):
            found = attribute(out, name)
            if found:
                wear = 100 - found[0]
                break
        else:
            if 231 in raw:
                wear = 100 - raw[231][1]
    temperature = labelled(out, "Temperature:")
    for name in ("Temperature_Celsius", "Airflow_Temperature_Cel"):
        found = attribute(out, name)
        if temperature is None and found:
            temperature = found[1]
    written = labelled(out, "Data Units Written")
    return {
        "wearPercent": wear,
        "temperatureC": temperature,
        # 241 counts GB on these Team SSDs; NVMe data units are 512,000 bytes.
        "writtenGB": raw[241][1] if 241 in raw else (round(written * 512_000 / 1e9) if written else None),
        "powerOnHours": raw[9][1] if 9 in raw else labelled(out, "Power On Hours"),
        "badSectors": sum(raw[key][1] for key in (5, 197, 198) if key in raw),
    }


def main():
    try:
        previous = {disk["device"]: disk for disk in json.load(open(OUT)).get("disks", [])}
    except (OSError, ValueError):
        previous = {}
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    disks = []
    for path in devices():
        name = path.rsplit("/", 1)[-1]
        rotational = open(f"/sys/block/{name}/queue/rotational").read().strip() == "1" if os.path.exists(f"/sys/block/{name}") else False
        before = previous.get(path, {})
        found = info(path)
        current = found or {key: before.get(key) for key in ("wearPercent", "temperatureC", "writtenGB", "powerOnHours", "badSectors")}
        # One point per day, kept a year: enough to see wear and write rate trends.
        history = [point for point in before.get("history", []) if point["day"] != today]
        history.append({"day": today, "writtenGB": current["writtenGB"], "wearPercent": current["wearPercent"]})
        disks.append({
            "device": path,
            "kind": "hdd" if rotational else "ssd",
            "health": health(path) if found else before.get("health", "unknown"),
            "asleep": found is None,
            **current,
            "history": history[-365:],
        })

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(f"{OUT}.tmp", "w") as handle:
        json.dump({
            "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "disks": disks,
        }, handle)
    os.replace(f"{OUT}.tmp", OUT)
    print(json.dumps(disks, indent=2))


if __name__ == "__main__":
    main()
