#!/bin/sh
set -eu

if [ "$(uname -s)" != Darwin ]; then
  echo "this installer is for macOS" >&2
  exit 1
fi
: "${KEEP_URL:?set KEEP_URL to the dashboard HTTPS address}"

ROOT=$(git -C "$(dirname "$0")/../.." rev-parse --show-toplevel)
BUN=$(command -v bun)
DATA=${KEEP_SESSIONS_DIR:-"$HOME/.local/share/keep-sessions"}
CLIENT="$DATA/sync.js"
PLIST="$HOME/Library/LaunchAgents/engineer.findmalek.keep-sessions.plist"
if [ -e "$CLIENT" ] || [ -L "$CLIENT" ] || [ -e "$PLIST" ] || [ -L "$PLIST" ]; then
  echo "session sync is already installed; existing files were left unchanged" >&2
  exit 1
fi
mkdir -p -m 700 "$DATA"
mkdir -p "$HOME/Library/LaunchAgents"
python3 - "$DATA" <<'PY'
import os, sys
stat = os.stat(sys.argv[1])
if stat.st_uid != os.getuid() or stat.st_mode & 0o077:
    raise SystemExit("session data directory must be private and owned by this user")
PY
"$BUN" build "$ROOT/src/sessions/cli.ts" --target=bun --outfile "$CLIENT"
chmod 600 "$CLIENT"
export KEEP_SESSIONS_DIR="$DATA"
python3 - "$PLIST" "$BUN" "$CLIENT" <<'PY'
import os, plistlib, sys

path, bun, client = sys.argv[1:]
env = {"HOME": os.environ["HOME"], "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"}
for key in ("KEEP_URL", "KEEP_SESSIONS_DIR", "KEEP_SESSIONS_INCLUDE", "KEEP_SESSIONS_EXCLUDE", "KEEP_SESSIONS_SOCKS_PROXY"):
    if key in os.environ:
        env[key] = os.environ[key]
data = {
    "Label": "engineer.findmalek.keep-sessions",
    "ProgramArguments": [bun, client, "push"],
    "EnvironmentVariables": env,
    "RunAtLoad": True,
    "StartInterval": 300,
    "StandardOutPath": os.path.join(env["KEEP_SESSIONS_DIR"], "sync.stdout.log"),
    "StandardErrorPath": os.path.join(env["KEEP_SESSIONS_DIR"], "sync.stderr.log"),
}
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "wb") as output:
    plistlib.dump(data, output)
PY
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "session sync installed; it will retry every five minutes"
