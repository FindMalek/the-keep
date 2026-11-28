<div align="center">

# keep dashboard

**A monochrome, single-page dashboard for one self-hosted box.**
CPU to containers, uptime to ad blocking, jobs you can run and a log of who logged in — on one screen, refreshed every second.

![Bun](https://img.shields.io/badge/runtime-Bun-101010?style=flat-square&labelColor=101010)
![React](https://img.shields.io/badge/ui-React%2019-101010?style=flat-square&labelColor=101010)
![No UI library](https://img.shields.io/badge/ui%20libraries-none-101010?style=flat-square&labelColor=101010)
![License](https://img.shields.io/badge/license-MIT-101010?style=flat-square&labelColor=101010)

![overview](docs/overview.png)

</div>

## What it shows

| Page | |
|---|---|
| **home** | Eight tiles (cpu, memory, data disk, temperature, network, sites, ads blocked, internet) that jump to their box, then cpu with per-core load and temperature squares, memory, network and disk i/o (in up, out down), volumes (the backup disk shown apart and not counted), disk health, internet tests, ad blocking, space per app and per bucket (each square links to the app), sites with response times, containers that need attention, and the system log. Graphs for live / 1 h / 24 h / 7 d / 30 d. `/system` and `/overview` redirect here. |
| **uptime** | Every Uptime Kuma check with a dithered strip over 24 h, 7 d or 30 d, response time, uptime for the range and days left on the TLS certificate; a summary strip of the worst check per bucket, search, filters, worst-first sort. |
| **apps** | Every Dokploy service as a card (status, domains, cpu and memory, last deploy, what it is), grouped by project with pins, previews and staging folded away, search, filters and sorting, plus the cleanup log. |
| **jobs** | Scheduled host jobs; open one to read its last and previous run straight from the journal, run it now, or jump to its logs. Server buttons (tidy, switches, reboot) and recent actions with who asked, how long it took and what it printed. |
| **logs** | The host journal: grep, time range, priority, unit, source and boot filters in the URL, a dithered volume chart you can click into, infinite scroll and live tail. |
| **activity** | Who's connected now, tailnet and lan devices, and a 7-day timeline with an hour-by-day heatmap, search, filter counts and sticky day headers. |
| **media** | Now playing, the Navidrome library (recently added and most played, linked to the album) and unread Miniflux articles. |
| **buckets** | Read-only Garage browser: folders, files, image thumbnails and previews for images, audio, video, pdf and text. |
| **sessions** | Claude Code and OpenCode sessions: cost per day heatmap, cost by model computed from stored prices (cache included), usage limits, a filtered list and a readable conversation view with tool calls. |

## Design

Warm monochrome boxes on a dark (or paper-light) page, Geist Sans for text and Geist Mono for numbers and labels.
All data is drawn as **ordered dither** (a 4×4 Bayer pattern of 2 px dots): meters, bars, uptime strips, heat squares.
The **only colors are orange and red**, and they mean one thing: something is close to (orange) or at (red) its
limit. Theme follows the OS, or pick one in the status bar (phone: under *more*). The full spec is
[`docs/design.md`](docs/design.md).

## How it works

```
browser ──SSE 1 s──▶ Bun server (container) ──reads──▶ host /proc, /sys, docker (read-only socket proxy)
                          │                         ──calls──▶ Garage, Dokploy, Kuma, AdGuard, Navidrome, Miniflux
                          │                         ──reads──▶ Speedtest Tracker's SQLite (ro)
                          └── /data (rw) ◀──writes── host/keep-agent  (jobs.json, activity.json, actions)
```

- One Bun process collects everything and streams a snapshot every second over Server-Sent Events; long-term
  history (1-minute averages and peaks, 31 days) lives in SQLite.
- The container never runs commands on the host. Buttons drop a request file into `/data/requests/`; the
  **host agent** (`host/keep-agent.py`, a systemd path unit) accepts only `reboot`, `tidy`, `run:<known job>` and
  `start:`/`stop:<configured switch>`, and refuses everything else. Requests need an `x-keep-action` header, so other sites can't trigger them.
- Every integration is optional: a panel shows "not reachable" or hides when its service isn't configured.

## Run it

The dashboard is meant to sit **behind your VPN** (it shows a lot about your box and has buttons that reboot
it). The reference setup is Dokploy + Traefik with a Tailscale-only route.

1. Copy `docker-compose.example.yml`, set the environment variables you need (table below) and deploy it.
2. Install the host side (as root):
   ```sh
   install -m 755 host/keep-agent.py /usr/local/bin/keep-agent
   install -m 755 host/keep-cleanup.py /usr/local/bin/keep-cleanup   # Dokploy only
   install -m 755 host/keep-tidy.py /usr/local/bin/keep-tidy
   install -m 755 host/keep-disk-watch.py /usr/local/bin/keep-disk-watch
   install -m 700 host/dk /usr/local/bin/dk                          # Dokploy API helper, reads /etc/dokploy-api.env
   cp host/systemd/* /etc/systemd/system/ && systemctl daemon-reload
   systemctl enable --now keep-agent.path keep-agent-status.timer keep-cleanup.timer keep-tidy.timer keep-disk-watch.timer
   ```
   Storage and drive health (the keep's own setup):
   ```sh
   install -m 755 host/keep-backup-pgdump.py /usr/local/bin/keep-backup-pgdump      # 02:30, before the 03:00 backup
   install -m 755 host/keep-backrest-status.py /usr/local/bin/keep-backrest-status  # 06:00, so the HDD can sleep
   install -m 755 host/keep-bucket-cap.py /usr/local/bin/keep-bucket-cap            # needs /etc/keep-garage-janitor.env
   install -m 755 host/keep-smart.py /usr/local/bin/keep-smart                      # daily, keeps a year of history
   install -m 755 host/keep-previews.py /usr/local/bin/keep-previews                # hourly, previews of closed PRs
   cp -r host/etc/. /etc/ && apt-get install -y hdparm systemd-zram-generator     # build cache cap, journald cap,
   systemctl restart docker systemd-journald && udevadm trigger                   # zram swap, HDD spin-down
   systemctl enable --now keep-backup-pgdump.timer keep-backrest-status.timer keep-bucket-cap.timer keep-smart.timer keep-previews.timer
   ```
   What each disk may hold, and what clears it, oldest first:

   | | cap | cleared by |
   |---|---|---|
   | docker build cache | 75 GB | BuildKit GC plus a hard trim every 15 min (keep-disk-watch), least recently used first; keep-tidy trims to 20 GB when a disk is over 75% |
   | images, stopped containers | in use or under 2 days | keep-tidy daily (1 day under pressure) |
   | Garage `turbo-cache` bucket | 20 GB | keep-bucket-cap hourly deletes the oldest objects down to 18 GB; 20 GiB quota and 14-day expiry behind it |
   | closed PR previews | — | keep-previews (hourly) deletes the app and its database once GitHub says the PR is closed |
| failing apps | — | keep-disk-watch stops anything that keeps failing for 15-30 min (Swarm or compose), Dokploy excepted |
| unused volumes | — | keep-tidy: previews' right away, anonymous after a day, any other after 30 days |
   | container logs | 3 × 10 MB | daemon.json; keep-tidy truncates any log over 100 MB from before the cap |
   | journal | 1 GB, 14 days | `host/etc/systemd/journald.conf.d/keep.conf` |
   | local backup HDD | 7 daily, 4 weekly, 3 monthly | Backrest prune weekly; plan and excludes in `deploy/backrest-local` |

   keep-disk-watch (every 15 min) sends to ntfy: a disk at 75%, no backup in 36h, a disk growing more than its daily
   allowance, SSD writes over budget or life under 80%, HDD bad sectors, heat or head parking, and failing services.

   Reachability from outside the house, checked twice so neither blind spot is left:
   ```sh
   install -m 755 host/keep-reachability.py /usr/local/bin/keep-reachability   # every 5 min
   systemctl enable --now keep-reachability.timer
   ```
   keep-reachability resolves every public Traefik host through Cloudflare DNS (not AdGuard's tailnet rewrite),
   fetches it at that address and checks `home.findmalek.engineer` still matches the box's public IP. A host is down
   after two failed runs; changes go to ntfy and `reachability.log`, the latest result to `reachability.json`.
   It can't report its own box being offline, so `.github/workflows/reachability.yml` checks the hosts in
   `.github/reachability-hosts.txt` from a GitHub runner every 10 minutes and pushes changes to ntfy (repo secret
   `NTFY_TOPIC`); a failed run also emails you. Never pin `*.findmalek.engineer` to the LAN IP in a browser or hosts
   file: it works at home and breaks every site everywhere else.

   n8n on the jobs page (workflow list, node graph, recent runs; read from n8n's database, no API key):
   ```sh
   install -m 755 host/keep-n8n-status.py /usr/local/bin/keep-n8n-status     # every 5 min, n8n-status.json
   install -m 755 host/keep-n8n-actions.py /usr/local/bin/keep-n8n-actions   # run button, allow-listed workflows only
   systemctl enable --now keep-n8n-status.timer keep-n8n-actions.path
   ```
   Allowed workflows live in `/etc/keep-dashboard-n8n-actions.json`; "run now" means dispatched, not finished.

   Telegram bot and outside heartbeat (ntfy stays as the loud channel):
   ```sh
   install -d -m 700 /etc/keep   # bot.env: TELEGRAM_TOKEN TELEGRAM_CHAT TELEGRAM_OWNER BOT_PIN GROQ_API_KEY HC_PING_KEY TZ DDNS_HOST
   install -m 755 host/keep-bot.py /usr/local/bin/keep-bot
   install -m 755 host/keep-heartbeat /usr/local/bin/keep-heartbeat
   systemctl enable --now keep-bot.service keep-heartbeat.timer
   ```
   keep-bot runs on the host, outside Docker, and only needs outbound internet (it falls back to DNS-over-HTTPS), so
   it still answers when Docker, Traefik, Tailscale or DDNS are broken. In a Telegram forum group it creates the
   topics alerts, control, actions, jobs, deploys, updates, access, mail and digest, then:
   - alerts with buttons that edit themselves on recovery: Uptime Kuma monitors, crashed or unhealthy containers
     (restarted once automatically), failed jobs and n8n runs, plus anything dropped in `<KEEP_DATA>/outbox/*.json`
     (keep-disk-watch, keep-reachability, keep-upgrade and the AI usage alert do)
   - commands (`/status /net /fix /graph /jobs /logs /restart /n8n /space /reboot /sh`) and plain language in any
     topic: Groq `openai/gpt-oss-120b` with read tools for the whole box (metrics, logs, journal, jobs, n8n runs node
     by node, docker space, dashboard data, read-only commands). Changes are only proposed as buttons; `/sh` and
     volume deletion also need the PIN on a button keypad, and a typed PIN is deleted
   - a pinned morning digest with a chart, job results, logins, and a network watchdog (re-apply the network after
     5 min offline, reboot after 15, at most hourly)
   keep-heartbeat pings healthchecks.io every minute, so a dead box or dead internet still reaches Telegram.
3. Optional: list your own systemd timers on the jobs page in `/srv/keep-dashboard/agent.json`, and apps that sleep
   when idle under `switches` to get start/stop buttons:
   `{"switches": {"minecraft": {"description": "game server", "filters": ["label=com.docker.compose.service=minecraft"]}}}`

### Security

- **VPN only, and only through your proxy.** Set `KEEP_GATE` to a long random value and have the VPN-only route add
  `X-Keep-Gate: <value>` (Traefik: a `headers.customRequestHeaders` middleware, which also overwrites a value a
  client sends). Without it every API call is refused, so other containers on the same Docker network can't read
  the dashboard or press its buttons. `/healthz` stays open for uptime checks.
- **No Docker socket in the container.** Docker is read through `docker-proxy/`, which forwards only
  `GET /containers/json` (not inspect, which would show other containers' secrets), on a network only the dashboard
  shares.
- **Buttons only ask.** The host agent decides: it accepts `reboot`, `tidy`, known jobs and start/stop of the
  switches you configured (each must match exactly one container), and refuses anything else.

### Configuration

| Variable | Default | |
|---|---|---|
| `MOUNTS` | `system=/:/` | `label=hostPath:containerPath` pairs; the container path is any directory on that filesystem |
| `NET_IFACES` | — | `enp5s0=lan,tailscale0=tailscale` |
| `SERVICES` | — | `name=url` quick checks (used when Kuma isn't configured) |
| `DDNS_HOST` | — | hostname whose A record should match your public IP |
| `GARAGE_ADMIN_URL` | — | `http://garage:3903`; admin token read from `GARAGE_CONFIG` |
| `DOKPLOY_URL`, `DOKPLOY_PUBLIC_URL` | — | Dokploy API (key from `DOKPLOY_ENV`) and the link base for services |
| `KUMA_URL` | — | Uptime Kuma, read via `/metrics` with the API key in `KUMA_KEY` |
| `KUMA_PUBLIC_URL`, `NAVIDROME_PUBLIC_URL`, `MINIFLUX_PUBLIC_URL`, `SPEEDTEST_PUBLIC_URL`, `DOZZLE_PUBLIC_URL` | — | where the boxes' links go |
| `BACKUP_MOUNTS` | `backup` | mount labels from `MOUNTS` that hold backups: shown apart, left out of the usable total |
| `JOURNAL_DIR` | `/host/journal` | the host's `/var/log/journal`, mounted read-only, for the logs page and job run logs; empty reads the local journal |
| `JOURNALCTL` | `journalctl` | command used to read it |
| `GARAGE_S3_URL`, `GARAGE_S3_KEY`, `GARAGE_S3_SECRET` | — | a read-only Garage key for the bucket browser; unset hides browsing |
| `GARAGE_S3_RW_KEY`, `GARAGE_S3_RW_SECRET` | — | a second Garage key with write grants on the cleanable buckets only; used for deletes, never for listing |
| `GARAGE_S3_DELETE_BUCKETS` | — | comma-separated buckets the browser may delete in (`ente*`, `skiffr*` and `*backup*` are always refused); empty turns deletes off |
| `SPEEDTEST_DB` | `/host/speedtest/database.sqlite` | Speedtest Tracker's database, mounted read-only |
| `KEEP_GATE` | — | the secret your VPN route sends as `X-Keep-Gate`; unset, the API is open to whatever reaches the port |
| `DOCKER_HOST` | — | `tcp://docker-proxy:2375`; without it, `DOCKER_SOCKET` (`/var/run/docker.sock`) |
| `DATA_DIR` | `/data` | history DB, files from the host agent, `integrations.env` (Navidrome / AdGuard / Miniflux credentials) |

Session costs come from per-model prices fetched daily from [models.dev](https://models.dev/api.json) into
`sessions.db` (a new row only when a price changes). To price a model it doesn't list, or override one, put
`[{"provider": "anthropic", "model": "claude-x", "input": 3, "output": 15, "cache_read": 0.3, "cache_write": 3.75}]`
(USD per million tokens) in `DATA_DIR/prices.json`.

Files the host side writes into `DATA_DIR` (all JSON): `jobs.json` and `activity.json` (agent), `actions.json`,
`cleanup-runs.json`, `tidy.json`, and optionally `usage.json` (per-app space against limits) and
`music-import.json` — the shapes are the `*Stats` types in [`src/shared/types.ts`](src/shared/types.ts).

## Develop

```sh
bun install
bun run typecheck
bun src/server.ts        # reads the host paths in HOST_PROC / HOST_SYS / HOST_ETC (default /host/…)
```

Working on the UI away from the host: capture the API's responses into a folder outside the repo (they contain real
IPs) and serve the UI from them. The logs page reads the real journal over ssh:

```sh
KEEP_FIXTURES=/tmp/fixtures JOURNALCTL=$PWD/scripts/dev-journalctl.sh JOURNAL_DIR= bun scripts/dev-fixtures.ts
```

The folder holds `snapshot.json`, `activity.json`, `h-<range>-<name>.json` from `/api/history`, `sessions/all.jsonl`
(one `/api/session` body per line) and optionally `buckets/<name>/…` as stand-in buckets.

Deploying to your own box: put `KEEP_HOST`, `COMPOSE_ID` and `SOURCE_DIR` in a git-ignored `.deploy.env` and run
`./deploy.sh`.

## License

MIT
