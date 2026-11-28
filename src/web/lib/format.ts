const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB"];
const RATE_UNITS = ["B/s", "KB/s", "MB/s", "GB/s"];

function scaled(value: number, base: number, units: string[]): { value: number; unit: string } {
  let index = 0;
  let current = Math.max(0, value);
  while (current >= base && index < units.length - 1) {
    current /= base;
    index += 1;
  }
  return { value: current, unit: units[index] ?? "" };
}

function digits(value: number): string {
  if (value === 0) return "0";
  if (value < 10) return value.toFixed(1);
  return Math.round(value).toString();
}

export function bytes(value: number): string {
  const { value: amount, unit } = scaled(value, 1024, BYTE_UNITS);
  return `${digits(amount)} ${unit}`;
}

export function rate(bytesPerSecond: number): string {
  const { value: amount, unit } = scaled(bytesPerSecond, 1000, RATE_UNITS);
  return `${digits(amount)} ${unit}`;
}

export function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function temperature(celsius: number | null): string {
  return celsius === null ? "—" : `${Math.round(celsius)}°`;
}

export function duration(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function shortHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Line speed in bits, the way ISPs quote it. */
export function mbps(bytesPerSecond: number, decimals = 1): string {
  const megabits = (bytesPerSecond * 8) / 1e6;
  return `${megabits >= 100 ? Math.round(megabits) : megabits.toFixed(decimals)} Mb/s`;
}

/** `850 ms`, `12.3 s`. */
export function ms(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return value >= 10_000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`;
}

/** `950`, `12.4k`, `3.21M`, `1.05B`: at most 6 characters. */
export function compact(value: number): string {
  const abs = Math.abs(value);
  if (abs < 1000) return String(Math.round(value));
  const [div, unit] = abs >= 1e9 ? [1e9, "B"] : abs >= 1e6 ? [1e6, "M"] : [1e3, "k"];
  const scaled = Math.abs(value / div);
  const digits = scaled >= 100 ? Math.round(scaled).toString() : scaled >= 10 ? scaled.toFixed(1) : scaled.toFixed(2);
  return `${value < 0 ? "-" : ""}${digits}${unit}`;
}

export function usd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value >= 1000) return `$${Math.round(value).toLocaleString("en-US")}`;
  return `$${value.toFixed(2)}`;
}

/** Path's last segment: `/Users/me/Projects/the-keep` → `the-keep`. */
export function baseName(path: string | null): string {
  if (!path) return "—";
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

/** First prompts often start with tool markup (`<command-message>…`), sometimes cut mid-tag; keep the words. */
export function cleanTitle(title: string | null): string {
  return (title ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/<[^>]*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export { projectOf } from "../../shared/project";

const WEEKDAYS: Record<string, string> = { Mon: "mondays", Tue: "tuesdays", Wed: "wednesdays", Thu: "thursdays", Fri: "fridays", Sat: "saturdays", Sun: "sundays" };

/** systemd calendar specs as people say them: `Fri *-*-* 17:00:00 UTC` → `fridays 17:00 utc`. */
export function humanSchedule(spec: string): string {
  const match = /^(?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+)?\*-\*-\*\s+(\d{2}):(\d{2})(?::\d{2})?(?:\s+(UTC))?$/.exec(spec.trim());
  if (!match) return spec;
  const [, day, hour, minute, zone] = match;
  return `${day ? WEEKDAYS[day] : "daily"} ${hour}:${minute}${zone ? " utc" : ""}`;
}
