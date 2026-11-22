#!/usr/bin/env python3
"""Free disk space on the-keep without touching anything that holds data.

Docker volumes, /srv data and running containers are never touched, nor stopped ones labeled `keep.sleeps=true`
(apps that stop themselves when idle and get started again later). Dangling volumes are only reported, never
deleted — deleting one can lose data; a human decides. Writes a summary to /srv/keep-dashboard/tidy.json for
the dashboard.
"""

import json
import os
import shutil
import subprocess
import time
from datetime import datetime, timezone

SUMMARY = os.path.join(os.environ.get("KEEP_DATA", "/srv/keep-dashboard"), "tidy.json")
BUILDX_CACHE = "/opt/buildx-cache"
STALE_AFTER_SEC = 7 * 86400

STEPS = [
    ("dokploy deployments and orphaned folders", ["/usr/local/bin/keep-cleanup"]),
    ("stopped containers older than 24h", ["docker", "container", "prune", "--force", "--filter", "until=24h",
                                           "--filter", "label!=keep.sleeps=true"]),
    # Images any container still uses (a sleeping app's too) are never pruned.
    ("unused images older than 7 days", ["docker", "image", "prune", "--all", "--force", "--filter", "until=168h"]),
    ("build cache older than 7 days", ["docker", "builder", "prune", "--force", "--filter", "until=168h"]),
    ("unused docker networks", ["docker", "network", "prune", "--force"]),
    ("old kernels and unused packages", ["apt-get", "autoremove", "--purge", "-y"]),
    ("journal logs older than 14 days", ["journalctl", "--vacuum-time=14d"]),
    ("apt package cache", ["apt-get", "clean"]),
    ("expired temp files", ["systemd-tmpfiles", "--clean"]),
]


def used_bytes():
    return sum(shutil.disk_usage(path).used for path in ("/", "/srv"))


def prune_buildx_cache():
    # CI's own cache-to/cache-from swap (preview.yml, staging.yml) is the real fix for unbounded
    # growth; this is a safety net for anything it misses (a removed workflow, a failed swap, an
    # app no one builds anymore) — delete blob files no CI run has touched in 7 days, then the
    # directories left empty by that.
    removed = 0
    if not os.path.isdir(BUILDX_CACHE):
        return {"removedFiles": 0}
    cutoff = time.time() - STALE_AFTER_SEC
    for root, _dirs, files in os.walk(BUILDX_CACHE):
        for name in files:
            path = os.path.join(root, name)
            try:
                if os.stat(path).st_mtime < cutoff:
                    os.remove(path)
                    removed += 1
            except OSError:
                pass
    for root, dirs, _files in os.walk(BUILDX_CACHE, topdown=False):
        for name in dirs:
            path = os.path.join(root, name)
            try:
                os.rmdir(path)
            except OSError:
                pass
    return {"removedFiles": removed}


def dangling_volumes():
    # Report only: dangling means no container references them (even stopped ones), so they are
    # almost certainly safe to delete, but the call is a human's.
    names = subprocess.run(["docker", "volume", "ls", "-q", "--filter", "dangling=true"],
                           capture_output=True, text=True, check=True).stdout.split()
    sizes = {}
    dfv = subprocess.run(["docker", "system", "df", "-v"], capture_output=True, text=True, check=True).stdout
    in_table = False
    for line in dfv.splitlines():
        if line.startswith("VOLUME NAME"):
            in_table = True
            continue
        if in_table:
            parts = line.split()
            if len(parts) >= 3:
                sizes[parts[0]] = parts[2]
            else:
                in_table = False
    return {"count": len(names), "bytes": sum(size_bytes(sizes.get(n, "0B")) for n in names),
            "largest": sorted(({"name": n, "size": sizes.get(n, "?")} for n in names),
                              key=lambda v: size_bytes(v["size"]), reverse=True)[:20]}


def size_bytes(text):
    # docker sizes like "7.539GB", "12MB", "1.273kB"
    units = {"B": 1, "kB": 1e3, "MB": 1e6, "GB": 1e9, "TB": 1e12}
    try:
        return int(float(text[:-2]) * units[text[-2:]])
    except (KeyError, ValueError):
        return 0


def main():
    before = used_bytes()
    steps = []
    for label, command in STEPS:
        result = subprocess.run(command, capture_output=True, text=True)
        steps.append({"label": label, "ok": result.returncode == 0})
    buildx = prune_buildx_cache()
    steps.append({"label": "stale CI build-cache files older than 7 days", "ok": True, **buildx})
    freed = max(0, before - used_bytes())

    summary = {"at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "freedBytes": freed, "steps": steps,
               "danglingVolumes": dangling_volumes()}
    print(json.dumps(summary))
    os.makedirs(os.path.dirname(SUMMARY), exist_ok=True)
    with open(SUMMARY, "w") as handle:
        json.dump(summary, handle)


if __name__ == "__main__":
    main()
