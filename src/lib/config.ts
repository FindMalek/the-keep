export interface MountConfig {
  label: string;
  path: string;
  /** Any directory inside the container that sits on the same filesystem as `path` on the host. */
  probe: string;
}

export interface InterfaceConfig {
  name: string;
  label: string;
}

export interface ServiceConfig {
  name: string;
  url: string;
}

export interface Config {
  port: number;
  historySize: number;
  mounts: MountConfig[];
  interfaces: InterfaceConfig[];
  services: ServiceConfig[];
  ddnsHost: string | null;
  garageAdminUrl: string | null;
  garageConfigPath: string;
  dokployUrl: string | null;
  dokployPublicUrl: string;
  dokployEnvPath: string;
  dataDir: string;
  kumaUrl: string | null;
  kumaKeyPath: string;
  links: { kuma: string | null; navidrome: string | null; miniflux: string | null; speedtest: string | null; dozzle: string | null };
  /** Mount labels that hold backups: shown apart, never counted as usable space. */
  backupMounts: string[];
  /** argv prefix for journalctl, and the host journal mounted into the container (empty reads the local one). */
  journalctl: string[];
  journalDir: string | null;
  garageS3: { url: string; key: string; secret: string; region: string; writeKey: { key: string; secret: string } | null } | null;
  /** Buckets the bucket browser may delete in; empty turns deletes off. */
  garageDeleteBuckets: string[];
}

function pairs(raw: string | undefined): [string, string][] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const index = entry.indexOf("=");
      return [entry.slice(0, index), entry.slice(index + 1)];
    });
}

/** MOUNTS="system=/:/host/fs/system,data=/srv:/host/fs/data" */
function parseMounts(raw: string | undefined): MountConfig[] {
  return pairs(raw).map(([label, rest]) => {
    const [path = "/", probe = "/"] = rest.split(":");
    return { label, path, probe };
  });
}

export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT ?? 8090),
    historySize: Number(process.env.HISTORY_SIZE ?? 300),
    mounts: parseMounts(process.env.MOUNTS ?? "system=/:/"),
    interfaces: pairs(process.env.NET_IFACES ?? "").map(([name, label]) => ({ name, label })),
    services: pairs(process.env.SERVICES ?? "").map(([name, url]) => ({ name, url })),
    ddnsHost: process.env.DDNS_HOST ?? null,
    garageAdminUrl: process.env.GARAGE_ADMIN_URL ?? null,
    garageConfigPath: process.env.GARAGE_CONFIG ?? "/host/garage.toml",
    dokployUrl: process.env.DOKPLOY_URL ?? null,
    dokployPublicUrl: process.env.DOKPLOY_PUBLIC_URL ?? "",
    dokployEnvPath: process.env.DOKPLOY_ENV ?? "/host/dokploy-api.env",
    dataDir: process.env.DATA_DIR ?? "/data",
    kumaUrl: process.env.KUMA_URL ?? null,
    kumaKeyPath: process.env.KUMA_KEY ?? "/host/kuma-metrics.key",
    links: {
      kuma: process.env.KUMA_PUBLIC_URL ?? null,
      navidrome: process.env.NAVIDROME_PUBLIC_URL ?? null,
      miniflux: process.env.MINIFLUX_PUBLIC_URL ?? null,
      speedtest: process.env.SPEEDTEST_PUBLIC_URL ?? null,
      dozzle: process.env.DOZZLE_PUBLIC_URL ?? null,
    },
    backupMounts: (process.env.BACKUP_MOUNTS ?? "backup").split(",").map((label) => label.trim()).filter(Boolean),
    journalctl: (process.env.JOURNALCTL ?? "journalctl").split(" ").filter(Boolean),
    journalDir: process.env.JOURNAL_DIR === undefined ? "/host/journal" : process.env.JOURNAL_DIR || null,
    garageS3:
      process.env.GARAGE_S3_URL && process.env.GARAGE_S3_KEY && process.env.GARAGE_S3_SECRET
        ? {
            url: process.env.GARAGE_S3_URL,
            key: process.env.GARAGE_S3_KEY,
            secret: process.env.GARAGE_S3_SECRET,
            region: process.env.GARAGE_S3_REGION ?? "garage",
            writeKey:
              process.env.GARAGE_S3_RW_KEY && process.env.GARAGE_S3_RW_SECRET ? { key: process.env.GARAGE_S3_RW_KEY, secret: process.env.GARAGE_S3_RW_SECRET } : null,
          }
        : null,
    garageDeleteBuckets: (process.env.GARAGE_S3_DELETE_BUCKETS ?? "").split(",").map((name) => name.trim()).filter(Boolean),
  };
}
