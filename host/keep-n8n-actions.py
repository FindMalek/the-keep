#!/usr/bin/env python3
"""Dispatch explicitly allowed n8n workflows requested by the dashboard."""

import glob
import json
import os
import re
import stat
import subprocess
import tempfile
from datetime import datetime, timezone

DATA = os.environ.get("KEEP_DATA", "/srv/keep-dashboard")
CONFIG = "/etc/keep-dashboard-n8n-actions.json"
ID = re.compile(r"^[A-Za-z0-9_-]{1,100}$")
CONTAINER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")


def config(path=CONFIG, trusted_uid=0):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd) as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != trusted_uid or info.st_mode & 0o022:
                return None
            data = json.load(handle)
        if not isinstance(data, dict) or not isinstance(data.get("allowed"), list):
            return None
        container = data.get("container")
        if not isinstance(container, str) or not CONTAINER.fullmatch(container):
            return None
        return data
    except (OSError, ValueError, TypeError):
        return None


def dispatch(workflow_id, settings):
    if not isinstance(workflow_id, str) or not ID.fullmatch(workflow_id):
        return "refused"
    if not settings or workflow_id not in settings["allowed"]:
        return "refused"
    try:
        result = subprocess.run(["docker", "exec", "-d", settings["container"], "n8n", "execute", f"--id={workflow_id}"],
                                capture_output=True, timeout=15)
        return "dispatched" if result.returncode == 0 else "failed"
    except (OSError, subprocess.SubprocessError):
        return "failed"


def record(workflow_id, status):
    path = os.path.join(DATA, "n8n-action-history.json")
    try:
        with open(path) as handle:
            history = json.load(handle)
        if not isinstance(history, list):
            history = []
    except (OSError, ValueError):
        history = []
    history.insert(0, {"workflowId": workflow_id, "status": status, "at": datetime.now(timezone.utc).isoformat()})
    fd, temporary = tempfile.mkstemp(prefix=".n8n-actions-", dir=DATA)
    try:
        with os.fdopen(fd, "w") as output:
            json.dump(history[:50], output)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def process():
    for path in sorted(glob.glob(os.path.join(DATA, "n8n-requests", "*.json")))[:50]:
        workflow_id = None
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd) as handle:
                info = os.fstat(handle.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_size > 4096:
                    raise ValueError("invalid request")
                value = json.load(handle)
            if isinstance(value, dict):
                workflow_id = value.get("workflowId")
        except (OSError, ValueError, TypeError):
            pass
        try:
            os.unlink(path)
        except OSError:
            continue
        status = dispatch(workflow_id, config())
        safe_id = workflow_id if isinstance(workflow_id, str) and ID.fullmatch(workflow_id) else None
        record(safe_id, status)


if __name__ == "__main__":
    process()
