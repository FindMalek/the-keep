#!/usr/bin/env bash
# Dev only: runs journalctl on the host over ssh so the logs page works against the fixture server.
# JOURNALCTL=scripts/dev-journalctl.sh JOURNAL_DIR= KEEP_FIXTURES=… bun scripts/dev-fixtures.ts
exec ssh "${KEEP_SSH_HOST:-the-keep}" "journalctl $(printf '%q ' "$@")"
