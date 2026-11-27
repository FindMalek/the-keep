#!/usr/bin/env python3
"""Read local restic snapshot metadata without exposing repository credentials."""

import json
import os
import subprocess
import sys
import tempfile
import time
from datetime import datetime

DATA = os.environ.get("KEEP_DATA", "/srv/keep-dashboard")
CONFIG = os.environ.get("KEEP_BACKREST_CONFIG", "")
CONTAINER = os.environ.get("KEEP_BACKREST_CONTAINER", "")
REPO_ID = os.environ.get("KEEP_BACKREST_REPO_ID", "")


def snapshot_view(snapshots):
    rows = []
    counts = {}
    for item in snapshots:
        plan = next((tag[5:] for tag in item.get("tags", []) if tag.startswith("plan:")), "unassigned")
        counts[plan] = counts.get(plan, 0) + 1
        at = int(datetime.fromisoformat(item["time"].replace("Z", "+00:00")).timestamp() * 1000)
        rows.append({"id": item["id"], "plan": plan, "repo": REPO_ID, "at": at})
    rows.sort(key=lambda item: item["at"], reverse=True)
    plans = [{"id": plan, "snapshots": count, "protectedBytes": None, "success": None,
              "warning": None, "failed": None, "nextAt": None} for plan, count in sorted(counts.items())]
    return {"status": "connected", "source": "host", "updatedAt": int(time.time() * 1000),
            "plans": plans, "snapshotsAvailable": True, "snapshots": rows[:10]}


def main():
    if not CONFIG or not CONTAINER or not REPO_ID:
        raise RuntimeError("Backrest collector is not configured")
    with open(CONFIG) as config:
        repo = next(item for item in json.load(config)["repos"] if item["id"] == REPO_ID)
    if not repo["uri"].startswith("/"):
        raise RuntimeError("only local repositories are supported")
    cmd = ["docker", "exec", "-i", CONTAINER, "sh", "-c",
           'IFS= read -r RESTIC_PASSWORD; export RESTIC_PASSWORD; exec restic -r "$1" snapshots --json',
           "sh", repo["uri"]]
    result = subprocess.run(cmd, input=repo["password"] + "\n", capture_output=True, text=True, timeout=90, check=True)
    data = snapshot_view(json.loads(result.stdout))
    os.makedirs(DATA, exist_ok=True)
    fd, path = tempfile.mkstemp(prefix=".backrest-status-", dir=DATA)
    try:
        with os.fdopen(fd, "w") as output:
            json.dump(data, output)
        os.replace(path, os.path.join(DATA, "backrest-status.json"))
    finally:
        if os.path.exists(path):
            os.unlink(path)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, StopIteration, subprocess.SubprocessError, RuntimeError) as error:
        print(f"Backrest status collection failed: {type(error).__name__}", file=sys.stderr)
        raise SystemExit(1)
