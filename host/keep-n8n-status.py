#!/usr/bin/env python3
"""Export non-secret n8n workflow and execution metadata for the dashboard."""

import json
import os
import subprocess
import stat
import tempfile
import time

DATA = os.environ.get("KEEP_DATA", "/srv/keep-dashboard")
CONTAINER = os.environ.get("KEEP_N8N_DB_CONTAINER", "")
RUN_CONFIG = "/etc/keep-dashboard-n8n-actions.json"

WORKFLOWS = '''SELECT coalesce(json_agg(row_to_json(w)), '[]'::json) FROM (
  SELECT id, name, active, nodes, connections FROM workflow_entity
  WHERE "isArchived" = false ORDER BY name LIMIT 301
) w'''
EXECUTIONS = '''SELECT coalesce(json_agg(row_to_json(e)), '[]'::json) FROM (
  SELECT id::text AS id, "workflowId", status, mode, "startedAt", "stoppedAt"
  FROM execution_entity
  ORDER BY "startedAt" DESC NULLS LAST LIMIT 50
) e'''


def query(sql):
    if not CONTAINER:
        raise RuntimeError("KEEP_N8N_DB_CONTAINER is not set")
    cmd = ["docker", "exec", CONTAINER, "sh", "-c",
           'exec psql -X -qAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"',
           "sh", "SET default_transaction_read_only = on; " + sql]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=20, check=True)
    return json.loads(result.stdout)


def allowed_workflows():
    try:
        fd = os.open(RUN_CONFIG, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd) as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                return set()
            data = json.load(handle)
        if not isinstance(data, dict) or not isinstance(data.get("allowed"), list):
            return set()
        return {value for value in data["allowed"] if isinstance(value, str)}
    except (OSError, ValueError, TypeError):
        return set()


def workflow_view(workflow, allowed=()):
    nodes = []
    for index, node in enumerate(workflow.get("nodes") or []):
        position = node.get("position") or []
        x = position[0] if len(position) > 0 and isinstance(position[0], (int, float)) else index * 200
        y = position[1] if len(position) > 1 and isinstance(position[1], (int, float)) else 0
        nodes.append({"name": node.get("name", ""), "type": node.get("type", ""), "x": x, "y": y, "disabled": bool(node.get("disabled"))})
    edges = []
    for source, kinds in (workflow.get("connections") or {}).items():
        for outputs in kinds.values():
            for targets in outputs:
                for target in targets or []:
                    edges.append({"from": source, "to": target.get("node", "")})
    return {"id": workflow["id"], "name": workflow["name"], "active": workflow["active"], "runnable": workflow["id"] in allowed, "nodes": nodes, "edges": edges}


def main():
    workflows = query(WORKFLOWS)
    executions = query(EXECUTIONS)
    allowed = allowed_workflows()
    result = {"status": "connected", "updatedAt": int(time.time() * 1000), "truncated": len(workflows) > 300,
              "executionsAvailable": True, "workflows": [workflow_view(w, allowed) for w in workflows[:300]], "executions": executions}
    os.makedirs(DATA, exist_ok=True)
    fd, path = tempfile.mkstemp(prefix=".n8n-status-", dir=DATA)
    try:
        with os.fdopen(fd, "w") as output:
            json.dump(result, output)
        os.replace(path, os.path.join(DATA, "n8n-status.json"))
    finally:
        if os.path.exists(path):
            os.unlink(path)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.SubprocessError, RuntimeError) as error:
        print(f"n8n status collection failed: {type(error).__name__}", file=__import__("sys").stderr)
        raise SystemExit(1)
