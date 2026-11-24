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
| **home** | Eight tiles (cpu, memory, data disk, temperature, network, sites up, ads blocked, internet speed), then cpu per core with clock and load, memory, network per interface, internet speed and ad blocking, volumes and disks, disk health, every temperature sensor, space per app against its limit, your public sites and every container. Graphs for live / 1 h / 24 h / 7 d / 30 d. `/system` and `/overview` redirect here. |
| **media** | Music from Navidrome, the Miniflux reading list, and Backrest plan and snapshot information. |
| **uptime** | Every Uptime Kuma check: status, a 24-hour strip of half-hour bars, response time, 24 h and 30 d uptime, days left on the TLS certificate. |
| **apps** | Every Dokploy project and service: containers, CPU, memory, domains, last deploy, plus a structured log of what the nightly cleanup removed. |
| **jobs** | Scheduled host jobs, n8n workflow diagrams and recent execution metadata, plus host actions. |
| **activity** | Tailnet devices, who's connected right now (SSH, Dokploy, this dashboard), and a 7-day timeline of logins, sudo commands, deploys, cleanups and reboots, folded into sessions. |
| **sessions** | Synced Claude Code and OpenCode conversations, filterable by repository. |

| system | uptime |
|---|---|
| ![system](docs/system.png) | ![uptime](docs/uptime.png) |
| **apps** | **jobs** |
| ![apps](docs/apps.png) | ![jobs](docs/jobs.png) |

![activity](docs/activity.png)

## Design

Black and white only, taken from the Zed *Monochrome* theme and a matching Ghostty palette: square corners,
hairline borders, IBM Plex Sans for text and JetBrains Mono for numbers. The **only colors are orange and
red**, and they mean one thing: something is close to (orange) or at (red) its limit. Light mode follows the OS.

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
   install -m 700 host/dk /usr/local/bin/dk                          # Dokploy API helper, reads /etc/dokploy-api.env
   cp host/systemd/* /etc/systemd/system/ && systemctl daemon-reload
   systemctl enable --now keep-agent.path keep-agent-status.timer keep-cleanup.timer keep-tidy.timer
   ```
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
| `KUMA_PUBLIC_URL`, `NAVIDROME_PUBLIC_URL`, `MINIFLUX_PUBLIC_URL` | — | where the panels' "open ↗" links go |
| `N8N_URL` | — | Internal n8n base URL. Add `N8N_API_KEY` to `DATA_DIR/integrations.env` or supply it as an environment variable. The key stays server-side. |
| `BACKREST_URL` | — | Internal Backrest URL. If authentication is enabled, add `BACKREST_USER` and `BACKREST_PASSWORD` to `DATA_DIR/integrations.env` or supply them as environment variables. Use a trusted private network or HTTPS. |
| `SPEEDTEST_DB` | `/host/speedtest/database.sqlite` | Speedtest Tracker's database, mounted read-only |
| `KEEP_GATE` | — | the secret your VPN route sends as `X-Keep-Gate`; unset, the API is open to whatever reaches the port |
| `DOCKER_HOST` | — | `tcp://docker-proxy:2375`; without it, `DOCKER_SOCKET` (`/var/run/docker.sock`) |
| `DATA_DIR` | `/data` | history DB, files from the host agent, `integrations.env` (Navidrome / AdGuard / Miniflux credentials) |

Files the host side writes into `DATA_DIR` (all JSON): `jobs.json` and `activity.json` (agent), `actions.json`,
`cleanup-runs.json`, `tidy.json`, and optionally `usage.json` (per-app space against limits) and
`music-import.json` — the shapes are the `*Stats` types in [`src/shared/types.ts`](src/shared/types.ts).

The n8n panel lists at most 300 workflows and the latest 50 execution records. It sends only node names, types, positions and connections to the browser, not node parameters or execution payloads. It does not execute workflows: n8n's public API does not provide a general run-by-ID endpoint. Run workflows through an appropriate n8n trigger until an explicitly authorized execution integration is configured.

Alternatively, install `host/keep-n8n-status.py` as `/usr/local/bin/keep-n8n-status`, configure `KEEP_N8N_DB_CONTAINER` in `/etc/keep-dashboard-n8n.env`, and enable `keep-n8n-status.timer`. The host collector reads n8n's database in a read-only transaction and writes a mode-0600, metadata-only file to `DATA_DIR`. The dashboard treats it as unavailable if it is older than three minutes. This fallback depends on n8n's database schema and must be checked when n8n is upgraded.

Backrest summaries come from `GetSummaryDashboard`; recent snapshot IDs come from indexed snapshot operations among the latest 200 operations. The list is not a complete inventory and does not verify that a restore will work.

For a local restic repository, `host/keep-backrest-status.py` can instead list snapshots without a Backrest login. Install it as `/usr/local/bin/keep-backrest-status`, configure `KEEP_BACKREST_CONFIG`, `KEEP_BACKREST_CONTAINER`, and `KEEP_BACKREST_REPO_ID` in `/etc/keep-dashboard-backrest.env`, and enable `keep-backrest-status.timer`. The host-only collector reads the repository password from Backrest's configuration and writes snapshot metadata, not credentials or paths, to a mode-0600 file. Its results expire after 30 minutes and do not report backup execution health.

`bun src/sessions/cli.ts push` imports local Claude Code and OpenCode sessions and sends them to `KEEP_URL` over HTTPS. The dashboard must support repository labels before a push will proceed. Set `KEEP_SESSIONS_INCLUDE` to comma-separated repository directories to restrict the sync, or `KEEP_SESSIONS_EXCLUDE` to exclude paths. Without an include list, all accessible sessions may be copied, including their messages and tool outputs. For a local Tailscale SOCKS proxy, set `KEEP_SESSIONS_SOCKS_PROXY` to `127.0.0.1:1055`. The local and server session databases are private to their owning user.

## Develop

```sh
bun install
bun run typecheck
bun src/server.ts        # reads the host paths in HOST_PROC / HOST_SYS / HOST_ETC (default /host/…)
```

Deploying to your own box: put `KEEP_HOST`, `COMPOSE_ID` and `SOURCE_DIR` in a git-ignored `.deploy.env` and run
`./deploy.sh`.

## License

MIT
