#!/usr/bin/env python3
"""Keep cache buckets in Garage under a size cap, deleting the oldest objects first (first in, first out).

Runs hourly. A bucket over its cap is trimmed to 90% of it, so the bucket quota (the hard ceiling that makes
uploads fail) is never reached. Uses rclone with the keep-janitor key from /etc/keep-garage-janitor.env
(GARAGE_KEY_ID / GARAGE_SECRET), which only has access to these buckets.
"""

import json
import os
import subprocess
import tempfile

CAPS_GB = {"turbo-cache": 20}
TRIM_TO = 0.9
ENV_FILE = "/etc/keep-garage-janitor.env"


def main():
    keys = dict(line.strip().split("=", 1) for line in open(ENV_FILE) if "=" in line)
    env = {**os.environ,
           "RCLONE_CONFIG_G_TYPE": "s3", "RCLONE_CONFIG_G_PROVIDER": "Other",
           "RCLONE_CONFIG_G_ENDPOINT": "http://127.0.0.1:3900", "RCLONE_CONFIG_G_REGION": "garage",
           "RCLONE_CONFIG_G_FORCE_PATH_STYLE": "true",
           "RCLONE_CONFIG_G_ACCESS_KEY_ID": keys["GARAGE_KEY_ID"], "RCLONE_CONFIG_G_SECRET_ACCESS_KEY": keys["GARAGE_SECRET"]}
    for bucket, cap_gb in CAPS_GB.items():
        listing = subprocess.run(["rclone", "lsjson", "--recursive", "--files-only", "--fast-list", f"g:{bucket}"],
                                 capture_output=True, text=True, check=True, env=env).stdout
        objects = sorted(json.loads(listing), key=lambda item: item["ModTime"])
        total = sum(item["Size"] for item in objects)
        if total <= cap_gb * 1e9:
            print(f"{bucket}: {total / 1e9:.1f} GB, under {cap_gb} GB")
            continue
        doomed, freed = [], 0
        for item in objects:
            if total - freed <= cap_gb * 1e9 * TRIM_TO:
                break
            doomed.append(item["Path"])
            freed += item["Size"]
        with tempfile.NamedTemporaryFile("w", suffix=".txt") as handle:
            handle.write("\n".join(doomed))
            handle.flush()
            subprocess.run(["rclone", "delete", "--files-from-raw", handle.name, f"g:{bucket}"], check=True, env=env)
        print(f"{bucket}: {total / 1e9:.1f} GB, deleted the oldest {len(doomed)} objects ({freed / 1e9:.1f} GB)")


if __name__ == "__main__":
    main()
