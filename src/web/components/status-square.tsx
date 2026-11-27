export type Status = "ok" | "warn" | "down" | "none";

const LABELS: Record<Status, string> = { ok: "up", warn: "degraded", down: "down", none: "unknown" };

/** 8×8: solid ink ok, solid warn, solid crit, outlined when unknown. Pair it with text on phone. */
export function StatusSquare({ status, label }: { status: Status; label?: string }) {
  return <span className={`status-square status-${status}`} role="img" aria-label={label ?? LABELS[status]} title={label} />;
}
