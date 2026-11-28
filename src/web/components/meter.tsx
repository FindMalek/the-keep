import { FILL, SECONDARY, snap, SOLID, TRACK } from "../lib/dither";
import { levelOf, USAGE, type Thresholds } from "../lib/level";
import { dither, useWidth, type Tone } from "./dither";

interface Segment {
  value: number;
  tone: "strong" | "mid" | "dim";
}

interface MeterProps {
  /** 0..1, or stacked segments that add up to at most 1. */
  value: number | Segment[];
  thresholds?: Thresholds;
  label?: string;
  height?: 8 | 12 | 16;
  /** Draw the warn and crit marks on the track. */
  ticks?: boolean;
}

/** Dithered fill on a dotted track; the fill's leading edge is solid so the exact value is readable. */
export function Meter({ value, thresholds = USAGE, label, height = 8, ticks = false }: MeterProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const segments: Segment[] = typeof value === "number" ? [{ value, tone: "mid" }] : value;
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  // In a stacked meter only the strong segment is pressure (memory cache is not).
  const measured = typeof value === "number" ? value : segments.filter((s) => s.tone === "strong").reduce((sum, s) => sum + s.value, 0);
  const level = levelOf(measured, thresholds);
  const tone: Tone = level === "normal" ? "ink" : level;

  let x = 0;
  const bars = segments.map((segment, index) => {
    const w = Math.max(0, Math.min(width - x, snap(width * Math.max(0, Math.min(1, segment.value)))));
    const bar = { x, w, lvl: segment.tone === "dim" ? SECONDARY : FILL, tone: segment.tone === "dim" ? ("ink" as Tone) : tone, index };
    x += w;
    return bar;
  });
  const lead = bars.find((bar) => bar.lvl === FILL && bar.w > 0);

  return (
    <div
      ref={ref}
      className="meter"
      style={{ height }}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(total * 100)}
    >
      {width > 0 && (
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} shapeRendering="crispEdges" aria-hidden="true">
          <rect width={width} height={height} fill={dither(TRACK)} />
          {bars.map((bar) => bar.w > 0 && <rect key={bar.index} x={bar.x} width={bar.w} height={height} fill={dither(bar.lvl, bar.tone)} />)}
          {lead && <rect x={Math.max(0, lead.x + lead.w - 2)} width={2} height={height} fill={dither(SOLID, lead.tone)} />}
          {ticks &&
            [thresholds.warn, thresholds.crit].map((ratio) => (
              <rect key={ratio} className="meter-tick" x={Math.min(width - 1, Math.round(width * ratio))} width={1} height={height} />
            ))}
        </svg>
      )}
    </div>
  );
}
