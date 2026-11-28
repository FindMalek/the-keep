export interface HostInfo {
  hostname: string;
  os: string;
  kernel: string;
  uptimeSec: number;
  processes: number;
  lanIp: string | null;
  tailscaleIp: string | null;
  publicIp: string | null;
  dnsIp: string | null;
}

export interface CpuStats {
  model: string;
  usage: number;
  cores: number[];
  freqMhz: number | null;
  load: [number, number, number];
}

export interface MemoryStats {
  total: number;
  used: number;
  cached: number;
  available: number;
  swapTotal: number;
  swapUsed: number;
}

export interface MountStats {
  label: string;
  path: string;
  device: string | null;
  total: number;
  used: number;
  /** Backup mounts are shown apart and never counted as usable space. */
  role?: "data" | "backup";
}

export interface DiskStats {
  name: string;
  model: string | null;
  sizeBytes: number;
  readBps: number;
  writeBps: number;
  readIops: number;
  writeIops: number;
  busy: number;
  tempC: number | null;
  mounts: string[];
}

export interface SmartDisk {
  device: string;
  kind?: "ssd" | "hdd";
  health: "passed" | "failed" | "unknown";
  /** Share of the rated endurance used up: 2 means 98% left. */
  wearPercent: number | null;
  temperatureC: number | null;
  writtenGB?: number | null;
  powerOnHours?: number | null;
  badSectors?: number | null;
  /** A sleeping HDD isn't woken for this; its values are from the last time it was awake. */
  asleep?: boolean;
  /** One point per day, oldest first. */
  history?: { day: string; writtenGB: number | null; wearPercent: number | null }[];
}

/** Written by keep-disk-watch every 15 minutes from the systemd journal. */
export interface JournalStats {
  at: number | null;
  diskBytes: number | null;
  capBytes: number | null;
  /** The last 24 hours, oldest first. */
  hours: { at: number; lines: number; errors: number; warnings: number }[];
  /** Who wrote the most in the last hour. */
  top: { source: string; lines: number }[];
}

export interface SmartStats {
  at: string | null;
  disks: SmartDisk[];
}

export interface NetStats {
  name: string;
  label: string;
  rxBps: number;
  txBps: number;
  rxTotal: number;
  txTotal: number;
  speedMbps: number | null;
}

export interface SensorReading {
  group: string;
  label: string;
  tempC: number;
}

export interface ContainerStats {
  id: string;
  name: string;
  project: string | null;
  /** Raw compose project or swarm service name; matches a Dokploy appName. */
  stack: string | null;
  /** From the `keep.domains` label, for routes Dokploy doesn't know about (e.g. Traefik file routes). */
  domains: string[];
  state: string;
  health: string | null;
  status: string;
  cpu: number;
  memBytes: number;
}

export interface BucketStats {
  name: string;
  bytes: number;
  objects: number;
  quotaBytes: number | null;
}

export interface GarageStats {
  healthy: boolean | null;
  buckets: BucketStats[];
}

export interface ServiceCheck {
  name: string;
  url: string;
  ok: boolean;
  status: number | null;
  latencyMs: number | null;
}

export type ServiceKind = "application" | "compose" | "postgres" | "redis" | "mysql" | "mariadb" | "mongo" | "libsql";

export interface AppService {
  id: string;
  name: string;
  kind: ServiceKind;
  status: string;
  domains: string[];
  lastDeploy: { status: string; title: string; at: string; durationSec: number | null } | null;
  running: number;
  total: number;
  cpu: number;
  memBytes: number;
  url: string;
}

export interface AppEnvironment {
  name: string;
  services: AppService[];
}

export interface AppProject {
  id: string;
  name: string;
  description: string | null;
  environments: AppEnvironment[];
}

export type CleanupItem =
  | {
      type: "deployment";
      /** Null only for runs recorded before ids were kept. */
      id: string | null;
      project: string;
      service: string;
      title: string;
      status: string;
      createdAt: string;
      reason: string;
    }
  | { type: "folder"; id: string; path: string; reason: string };

/** One `keep-cleanup` run on the host, newest first in `cleanup-runs.json`. */
export interface CleanupRun {
  id: string;
  at: string;
  durationMs: number | null;
  removed: CleanupItem[];
  unmanaged: { id?: string; name: string; state: string; stack: string | null }[];
}

export interface AppsStats {
  reachable: boolean;
  projects: AppProject[];
  cleanupRuns: CleanupRun[];
}

export interface JobStatus {
  name: string;
  description: string;
  schedule: string;
  /** Unix seconds. */
  lastRun: number | null;
  lastResult: "success" | "failed" | "running" | null;
  durationSec: number | null;
  nextRun: number | null;
  runnable: boolean;
  /** Listed so it isn't forgotten, but not set up yet. */
  planned?: boolean;
}

export interface ActionRecord {
  action: string;
  at: string;
  status: "done" | "failed" | "refused";
  detail: string;
  /** Requester's IP, written by the server into the request file. Older records don't have the fields below. */
  requestedBy?: string | null;
  startedAt?: string | null;
  durationSec?: number | null;
  exitCode?: number | null;
  /** Last lines the action printed, at most 4 KB. */
  output?: string | null;
  freedBytes?: number | null;
}

export interface TidySummary {
  at: string;
  freedBytes: number;
  steps: { label: string; ok: boolean }[];
}

/** Written by `keep-agent` / `keep-tidy` on the host. */
/** An app that sleeps when idle, with start/stop buttons (agent.json `switches`). */
export interface SwitchStatus {
  name: string;
  description: string;
  running: boolean;
}

export interface BackupStatus {
  at: string | null;
  status: "success" | "failed" | "running" | "unknown";
  sizeBytes: number | null;
  durationSec: number | null;
}

export interface GitHubRunner {
  id: number;
  name: string;
  repo: string;
  status: "online" | "offline";
  busy: boolean;
  labels: string[];
}

export interface GitHubRun {
  id: number;
  repo: string;
  workflow: string;
  status: string;
  conclusion: string | null;
  branch: string;
  url: string;
  startedAt: string | null;
}

export interface GitHubCiStatus {
  updatedAt: string | null;
  runners: GitHubRunner[];
  runs: GitHubRun[];
}

export interface AiUsageEntry {
  tool: string;
  machine: string;
  fiveHourPct: number | null;
  weeklyPct: number | null;
  fiveHourResetsAt: string | null;
  weeklyResetsAt: string | null;
  at: string;
}

export interface N8nStats {
  status: "not configured" | "unreachable" | "connected";
  truncated: boolean;
  executionsAvailable: boolean;
  workflows: {
    id: string;
    name: string;
    active: boolean;
    runnable?: boolean;
    nodes: { name: string; type: string; x: number; y: number; disabled: boolean }[];
    edges: { from: string; to: string }[];
  }[];
  executions: { id: string; workflowId: string; status: string; mode: string; startedAt: string | null; stoppedAt: string | null }[];
  actions?: { workflowId: string | null; status: string; at: string }[];
}

export interface BackrestStats {
  status: "not configured" | "unreachable" | "connected";
  source?: "host" | "api";
  plans: { id: string; snapshots: number; protectedBytes: number | null; success: number | null; warning: number | null; failed: number | null; nextAt: number | null }[];
  snapshotsAvailable: boolean;
  snapshots: { id: string; plan: string; repo: string; at: number }[];
}

export interface JobsStats {
  updatedAt: string | null;
  jobs: JobStatus[];
  switches: SwitchStatus[];
  actions: ActionRecord[];
  tidy: TidySummary | null;
  backup: BackupStatus | null;
  github: GitHubCiStatus | null;
  aiUsage: AiUsageEntry[];
}

/** Where the "open ↗" links on panels point; each is optional and hidden when unset. */
export interface Links {
  kuma: string | null;
  navidrome: string | null;
  miniflux: string | null;
  speedtest?: string | null;
  dozzle?: string | null;
}

export interface Snapshot {
  at: number;
  links: Links;
  host: HostInfo;
  cpu: CpuStats;
  memory: MemoryStats;
  mounts: MountStats[];
  disks: DiskStats[];
  network: NetStats[];
  sensors: SensorReading[];
  smart: SmartStats;
  journal: JournalStats;
  containers: ContainerStats[];
  garage: GarageStats;
  services: ServiceCheck[];
  apps: AppsStats;
  jobs: JobsStats;
  uptime: UptimeStats;
  usage: UsageStats;
  home: HomeStats;
}

/** One sample per tick, keyed like `cpu`, `mem`, `net:enp5s0:rx`, `disk:sda:write`. */
export type Points = Record<string, number>;

export type History = Record<string, number[]>;

export interface InitialPayload {
  snapshot: Snapshot;
  history: History;
  historySize: number;
}

export interface TickPayload {
  snapshot: Snapshot;
  points: Points;
}

export type RangeName = "live" | "1h" | "24h" | "7d" | "30d";

export interface RangeSeries {
  avg: (number | null)[];
  max: (number | null)[];
}

export interface RangeHistory {
  range: Exclude<RangeName, "live">;
  stepSec: number;
  /** Unix seconds of the first bucket. */
  start: number;
  series: Record<string, RangeSeries>;
}

export interface Device {
  name: string;
  os: string;
  self: boolean;
  tailscaleIp: string | null;
  lanIp: string | null;
  online: boolean;
  lastSeen: string | null;
  route: string;
  rxBytes: number;
  txBytes: number;
}

export interface OpenSession {
  id: string;
  user: string | null;
  source: string | null;
  since: number | null;
}

export interface HostEvent {
  /** Unix seconds. */
  at: number;
  kind: "ssh" | "ssh-failed" | "sudo" | "boot";
  user: string | null;
  source: string | null;
  detail: string;
  key: string | null;
  endedAt: number | null;
}

export interface DokploySession {
  id: string;
  email: string;
  ip: string | null;
  userAgent: string;
  createdAt: string;
  expiresAt: string;
}

export interface DeployEvent {
  id: string;
  at: string;
  project: string;
  service: string;
  status: string;
  title: string;
  durationSec: number | null;
}

export interface Viewer {
  ip: string;
  userAgent: string;
  firstSeen: number;
  lastSeen: number;
  live: boolean;
}

export interface NetworkDevice {
  ip: string;
  mac: string | null;
  name: string;
  online: boolean;
  storage: { used: number; total: number } | null;
}

export interface ActivityPayload {
  updatedAt: string | null;
  devices: Device[];
  networkDevices: NetworkDevice[];
  openSessions: OpenSession[];
  events: HostEvent[];
  dokploySessions: DokploySession[];
  deploys: DeployEvent[];
  viewers: Viewer[];
  actions: ActionRecord[];
  cleanupRuns: CleanupRun[];
  publicIp: string | null;
}

/** One Uptime Kuma check, from its Prometheus /metrics endpoint. */
export interface KumaMonitor {
  id: string;
  name: string;
  type: string;
  url: string | null;
  /** 0 down, 1 up, 2 pending, 3 maintenance. */
  status: number;
  responseMs: number | null;
  uptime1d: number | null;
  uptime30d: number | null;
  certDays: number | null;
}

export interface UptimeStats {
  reachable: boolean;
  monitors: KumaMonitor[];
}

/** Written every 15 min by `keep-usage` on the host: bytes per path under /srv. */
export interface UsageItem {
  key: string;
  label: string;
  detail: string;
  used: number;
  limit: number | null;
  /** Enforced by the app itself (bucket quota, Seafile quota); otherwise the limit only triggers alerts. */
  hard: boolean;
  /** The app's own page, written by `keep-usage`; the client falls back to a matching Dokploy domain. */
  url?: string;
}

export interface UsageStats {
  at: string | null;
  paths: Record<string, number>;
  items?: UsageItem[];
}

export interface MusicStats {
  reachable: boolean;
  songs: number;
  albums: number;
  artists: number;
  nowPlaying: { user: string; title: string; artist: string; album: string; minutesAgo: number; player: string }[];
  recentlyAdded: { id?: string; album: string; artist: string; year: number | null }[];
  /** Most played albums, when Navidrome reports play counts. */
  frequent?: { id: string; album: string; artist: string; plays: number }[];
  lastImport: { at: string; imported: number; waiting: number; leftInInbox: number } | null;
}

export interface DnsStats {
  reachable: boolean;
  protection: boolean;
  queries: number;
  blocked: number;
  avgMs: number;
  /** Last 24 hours, one value per hour, oldest first. */
  hourlyQueries: number[];
  hourlyBlocked: number[];
  topBlocked: { domain: string; count: number }[];
}

export interface SpeedResult {
  at: string;
  downBps: number;
  upBps: number;
  pingMs: number;
}

export interface InternetStats {
  latest: (SpeedResult & { isp: string | null; server: string | null }) | null;
  /** Oldest first. */
  history: SpeedResult[];
}

export interface ReadingStats {
  reachable: boolean;
  unread: number;
  feeds: number;
  latest: { title: string; feed: string; url: string; publishedAt: string }[];
}

export interface HomeStats {
  music: MusicStats;
  dns: DnsStats;
  internet: InternetStats;
  reading: ReadingStats;
}

/** One journald entry. `at` is microseconds since the epoch, as journald stores it. */
export interface LogEntry {
  cursor: string;
  at: number;
  priority: number;
  source: string;
  unit: string | null;
  pid: number | null;
  message: string;
  fields?: Record<string, string>;
}

export interface LogPage {
  /** Newest first. */
  entries: LogEntry[];
  /** Cursor to pass as `before` for older entries; null at the start of the journal. */
  before: string | null;
  /** Cursor to pass as `after` to poll for newer entries. */
  after: string | null;
}

export interface LogHistogram {
  /** Unix ms of the first bucket. */
  from: number;
  stepMs: number;
  buckets: { lines: number; errors: number }[];
  /** True when journalctl was cut off before reading the whole range. */
  partial: boolean;
}

export interface JobRun {
  invocation: string;
  /** Unix ms. */
  start: number;
  end: number | null;
  result: "success" | "failed" | "running" | "unknown";
  /** Oldest first. */
  lines: LogEntry[];
}

export interface BucketObject {
  key: string;
  size: number;
  /** Unix ms. */
  modified: number;
  etag: string | null;
}

export interface BucketListing {
  prefixes: string[];
  objects: BucketObject[];
  /** Pass as `after` for the next page; null when this is the last. */
  next: string | null;
  /** Whether the dashboard may delete in this bucket, and if not, why. Set by the API on every page. */
  deletable?: boolean;
  locked?: string | null;
}

/** Everything under a prefix, counted recursively. */
export interface PrefixTotal {
  objects: number;
  bytes: number;
  /** Counting stopped at the cap; the numbers are a floor. */
  capped: boolean;
}

export interface BucketDeleteResult {
  deleted: number;
  bytes: number;
  failed: string[];
}

export interface PriceTier {
  above: number;
  input: number;
  output: number;
  cacheRead: number | null;
  cacheWrite: number | null;
}

export interface ModelPrice {
  provider: string;
  model: string;
  /** USD per million tokens. */
  input: number;
  output: number;
  cacheRead: number | null;
  cacheWrite: number | null;
  reasoning: number | null;
  /** Higher rates once the prompt passes `above` tokens (long-context pricing), lowest threshold first. */
  tiers: PriceTier[];
  source: "models.dev" | "manual";
  validFrom: number;
}

export interface SessionListRow {
  id: string;
  tool: string;
  machine: string;
  directory: string | null;
  branch: string | null;
  title: string | null;
  startedAt: number;
  endedAt: number;
  messageCount: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  /** Computed from stored prices; null when no message had a known price. */
  costUsd: number | null;
  /** What the tool itself reported, for comparison. */
  reportedUsd: number | null;
  unpriced: number;
  models: string[];
  /** Subagent runs grouped under this conversation; their tokens and cost are included above. */
  subagents: number;
  /** A subagent run whose conversation isn't stored, listed on its own. */
  agentRun: boolean;
}

export interface UsageDay {
  day: string;
  tool: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  /** Messages whose model has no price. */
  unpriced: number;
  sessions: number;
}

export interface SessionsPayload {
  sessions: SessionListRow[];
  total: number;
  usage: UsageDay[];
  pricesUpdatedAt: number | null;
}

export interface SessionFacets {
  tools: string[];
  machines: string[];
  projects: string[];
  models: string[];
}
