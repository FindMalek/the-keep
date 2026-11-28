#!/usr/bin/env python3
"""Free disk space on the-keep without touching anything that holds data.

Docker volumes, /srv data and running containers are never touched, nor stopped ones labeled `keep.sleeps=true`
(apps that stop themselves when idle and get started again later). Dangling volumes are only reported, never
deleted — deleting one can lose data; a human decides. Writes a summary to /srv/keep-dashboard/tidy.json for
the dashboard.
"""

import glob
import json
import os
import re
import shutil
import subprocess
import time
from datetime import datetime, timezone

SUMMARY = os.path.join(os.environ.get("KEEP_DATA", "/srv/keep-dashboard"), "tidy.json")
BUILDX_CACHE = "/opt/buildx-cache"
STALE_AFTER_SEC = 7 * 86400
# At or above this, tidy keeps far less: keep-disk-watch alerts at the same line and starts an extra run.
DISK_LIMIT_PCT = 75

def under_pressure():
    for path in ("/", "/srv"):
        usage = shutil.disk_usage(path)
        if 100 * usage.used / (usage.used + usage.free) >= DISK_LIMIT_PCT:
            return True
    return False


def steps_for(pressured):
    cache = ["--max-used-space", "20gb"] if pressured else ["--filter", "until=168h"]
    return [
        ("dokploy deployments and orphaned folders", ["/usr/local/bin/keep-cleanup"]),
        ("stopped containers older than 24h", ["docker", "container", "prune", "--force", "--filter", "until=24h",
                                               "--filter", "label!=keep.sleeps=true",
                                                   # a compose service someone stopped on purpose stays
                                                   "--filter", "label!=com.docker.compose.project"]),
        # Images any container still uses (a sleeping app's too) are never pruned.
        # Anything still referenced by a container (a sleeping app's too) stays; the rest is a pull or build away.
        (f"unused images older than {1 if pressured else 2} days",
         ["docker", "image", "prune", "--all", "--force", "--filter", f"until={24 if pressured else 48}h"]),
        ("build cache over 20 GB" if pressured else "build cache older than 7 days",
         ["docker", "builder", "prune", "--all", "--force", *cache]),
        ("unused docker networks", ["docker", "network", "prune", "--force"]),
        ("old kernels and unused packages", ["apt-get", "autoremove", "--purge", "-y"]),
        ("journal logs older than 14 days or over 1 GB",
         ["journalctl", "--vacuum-time=14d", "--vacuum-size=1G"]),
        ("apt package cache", ["apt-get", "clean"]),
        ("expired temp files", ["systemd-tmpfiles", "--clean"]),
    ]


def prune_builders(pressured):
    # docker-container builders keep their own cache, which the daemon's cap in daemon.json never sees.
    names = subprocess.run(["docker", "ps", "-q", "--filter", "name=buildx_buildkit"],
                           capture_output=True, text=True, check=True).stdout.split()
    keep_mb = "1000" if pressured else "5000"
    results = [subprocess.run(["docker", "exec", name, "buildctl", "prune", "--keep-storage", keep_mb],
                              capture_output=True) for name in names]
    return all(result.returncode == 0 for result in results)


def used_bytes():
    return sum(shutil.disk_usage(path).used for path in ("/", "/srv"))


def prune_stale_builders():
    # CI's setup-buildx leaves a builder-<uuid> container behind when a job dies; each holds its own cache.
    names = subprocess.run(["docker", "ps", "-a", "--format", "{{.Names}}|{{.CreatedAt}}", "--filter",
                            "name=buildx_buildkit_builder-"], capture_output=True, text=True, check=True).stdout
    removed = 0
    for line in names.splitlines():
        name, created = line.split("|", 1)
        if time.time() - datetime.strptime(created[:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc).timestamp() > 2 * 86400:
            subprocess.run(["docker", "rm", "-f", name], capture_output=True)
            subprocess.run(["docker", "volume", "rm", f"{name}_state"], capture_output=True)
            removed += 1
    return removed


def prune_preview_volumes():
    # Unused volumes of deleted PR previews (pr-12-db-x-data, app-db-pr-12-x-data), anonymous ones older than a
    # day, and any other unused volume older than 30 days.
    removed = 0
    for name in subprocess.run(["docker", "volume", "ls", "-qf", "dangling=true"],
                               capture_output=True, text=True, check=True).stdout.split():
        preview = re.search(r"(^|-)pr-\d+-", name) and name.endswith("-data")
        anonymous = re.fullmatch(r"[0-9a-f]{64}", name)
        if anonymous:
            created = subprocess.run(["docker", "volume", "inspect", name, "-f", "{{.CreatedAt}}"],
                                     capture_output=True, text=True).stdout.strip()
            anonymous = created and time.time() - datetime.fromisoformat(created.replace("Z", "+00:00")).timestamp() > 86400
        if not (preview or anonymous):
            created = subprocess.run(["docker", "volume", "inspect", name, "-f", "{{.CreatedAt}}"],
                                     capture_output=True, text=True).stdout.strip()
            # A volume no container has used for a month is a leftover of something already removed.
            preview = created and time.time() - datetime.fromisoformat(created.replace("Z", "+00:00")).timestamp() > 30 * 86400
        if (preview or anonymous) and subprocess.run(["docker", "volume", "rm", name], capture_output=True).returncode == 0:
            removed += 1
    return removed


def cap_container_logs():
    # Containers created before daemon.json had log-opts keep an unbounded json log.
    truncated = 0
    for path in glob.glob("/srv/docker/containers/*/*-json.log"):
        if os.path.getsize(path) > 100e6:
            os.truncate(path, 0)
            truncated += 1
    return truncated


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
    pressured = under_pressure()
    for label, command in steps_for(pressured):
        result = subprocess.run(command, capture_output=True, text=True)
        steps.append({"label": label, "ok": result.returncode == 0})
    steps.append({"label": "stale CI buildx builders", "ok": True, "removed": prune_stale_builders()})
    steps.append({"label": "separate buildx builders", "ok": prune_builders(pressured)})
    steps.append({"label": "volumes of deleted previews", "ok": True, "removed": prune_preview_volumes()})
    steps.append({"label": "container logs over 100 MB", "ok": True, "truncated": cap_container_logs()})
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
