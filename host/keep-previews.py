#!/usr/bin/env python3
"""Delete PR preview deployments in Dokploy once their pull request is closed or merged.

Runs hourly. Previews are the apps and databases named like `pr-123-api` or `ceraghit-web-pr-123` in the preview
projects below; the PR state comes from GitHub's public API (the repos are public, no token needed). Anything
that can't be checked (network error, unknown project) is left alone.
Usage: keep-previews [--dry-run]
"""

import json
import re
import subprocess
import sys
import urllib.request

# Dokploy project -> GitHub repo whose PRs it previews.
PROJECTS = {
    "ceraghit-previews": "FindMalek/ceraghit",
    "lodesong-previews": "FindMalek/lodesong",
    "keep-player-previews": "FindMalek/lodesong",
    "lehoetel-previews": "FindMalek/ritorno",
}
KINDS = {"applications": ("application.delete", "applicationId"), "postgres": ("postgres.remove", "postgresId")}
dry_run = "--dry-run" in sys.argv


def dk(method, procedure, body=None):
    args = ["/usr/local/bin/dk", method, procedure] + ([json.dumps(body)] if body is not None else [])
    out = subprocess.run(args, capture_output=True, text=True, check=True).stdout
    return json.loads(out) if out.strip() else None


def pr_state(repo, number, cache={}):
    if (repo, number) not in cache:
        request = urllib.request.Request(f"https://api.github.com/repos/{repo}/pulls/{number}",
                                         headers={"Accept": "application/vnd.github+json", "User-Agent": "keep-previews"})
        try:
            cache[(repo, number)] = json.load(urllib.request.urlopen(request, timeout=15))["state"]
        except Exception as error:
            print(f"skip {repo}#{number}: {error}", file=sys.stderr)
            cache[(repo, number)] = None
    return cache[(repo, number)]


def main():
    for project in dk("GET", "project.all"):
        repo = PROJECTS.get(project["name"])
        if not repo:
            continue
        for environment in project["environments"]:
            for kind, (procedure, id_field) in KINDS.items():
                for item in environment.get(kind, []):
                    match = re.search(r"(?:^|-)pr-(\d+)(?:-|$)", item["name"])
                    if not match or pr_state(repo, int(match[1])) != "closed":
                        continue
                    print(f"{'would delete' if dry_run else 'deleting'} {item['name']} ({repo}#{match[1]} is closed)")
                    if not dry_run:
                        dk("POST", procedure, {id_field: item[id_field]})


if __name__ == "__main__":
    main()
