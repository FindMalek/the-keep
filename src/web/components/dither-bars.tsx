import { useState, type KeyboardEvent, type PointerEvent } from "react";
import { AREA, DOT, FILL, peaks, SECONDARY, snapDown, SOLID, TRACK } from "../lib/dither";
import { dither, useWidth, type Tone } from "./dither";
import { niceTop } from "./sparkline";

interface DitherBarsProps {
  values: (number | null)[];
  /** Drawn over each bar from the baseline: errors over lines (crit), blocked over queries (secondary). */
  overlay?: (number | null)[];
  overlayTone?: "crit" | "secondary";
  max?: number;
  height?: number;
  format: (value: number) => string;
  /** One per value, for the tooltip; the first, middle and last are also printed under the chart. */
  labels?: string[];
  axis?: boolean;
  label: string;
  tone?: Tone;
  onPick?: (index: number) => void;
  /** Tooltip line for a bar; defaults to label · value. */
  describe?: (index: number) => string;
}

const GAP = 2;

/** Dithered bars at real pixel size, spread across the full width; too many to fit get merged, keeping peaks. */
export function DitherBars({ values, overlay, overlayTone = "crit", max, height = 40, format, labels, axis = true, label, tone = "ink", onPick, describe }: DitherBarsProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);

  const fit = Math.max(1, Math.floor((width + GAP) / (DOT + GAP)));
  const merged = values.length > fit;
  const shown = merged ? peaks(values, fit) : values;
  const shownOverlay = overlay ? (merged ? peaks(overlay, fit) : overlay) : null;
  const n = shown.length;
  const barW = Math.max(DOT, snapDown((width - (n - 1) * GAP) / n));
  const pad = Math.max(0, snapDown(width - (n * barW + (n - 1) * GAP)));
  const xOf = (index: number) => pad + index * (barW + GAP);
  const top = max ?? niceTop(Math.max(0, ...shown.filter((v): v is number => v !== null)));
  const span = height - DOT;
  const h = (value: number) => Math.max(DOT, snapDown((Math.min(value, top) / top) * span));
  const bars: string[] = [];
  const caps: string[] = [];
  const stubs: string[] = [];
  const over: string[] = [];
  shown.forEach((value, index) => {
    const x = xOf(index);
    if (value === null) {
      stubs.push(`M${x} ${height - DOT}h${barW}v${DOT}h-${barW}z`);
      return;
    }
    if (value <= 0) return;
    const y = height - h(value);
    bars.push(`M${x} ${y}h${barW}v${height - y}h-${barW}z`);
    caps.push(`M${x} ${y}h${barW}v${DOT}h-${barW}z`);
    const extra = shownOverlay?.[index];
    if (extra) {
      const oy = height - h(extra);
      over.push(`M${x} ${oy}h${barW}v${height - oy}h-${barW}z`);
    }
  });

  const pick = (index: number) => (merged ? Math.min(values.length - 1, Math.floor(((index + 0.5) * values.length) / n)) : index);
  const text = (index: number) => {
    const source = pick(index);
    if (describe) return describe(source);
    const value = shown[index];
    return `${labels?.[source] ? `${labels[source]} · ` : ""}${value === null || value === undefined ? "no data" : format(value)}`;
  };

  function onPointerMove(event: PointerEvent<HTMLDivElement>): void {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const index = Math.floor((x - pad + GAP / 2) / (barW + GAP));
    setActive(index >= 0 && index < n ? index : null);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      setActive((current) => Math.max(0, Math.min(n - 1, (current ?? n - 1) + (event.key === "ArrowRight" ? 1 : -1))));
    } else if (event.key === "Enter" && active !== null) onPick?.(pick(active));
  }

  const overlayFill = overlayTone === "crit" ? dither(FILL, "crit") : dither(SECONDARY, "ink");
  const tipLeft = active === null ? 0 : Math.min(Math.max(0, xOf(active) - 40), Math.max(0, width - 160));

  return (
    <div className={`bars${onPick ? " is-pickable" : ""}`}>
      <div
        ref={ref}
        className="bars-plot"
        style={{ height }}
        tabIndex={0}
        role="img"
        aria-label={label}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setActive(null)}
        onBlur={() => setActive(null)}
        onKeyDown={onKeyDown}
        onClick={() => active !== null && onPick?.(pick(active))}
      >
        {width > 0 && (
          <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} shapeRendering="crispEdges" aria-hidden="true">
            <path d={bars.join("")} fill={dither(AREA, tone)} />
            <path d={over.join("")} fill={overlayFill} />
            <path d={caps.join("")} fill={dither(SOLID, tone)} />
            <path d={stubs.join("")} fill={dither(TRACK)} />
            {active !== null && <rect className="bars-cursor" x={xOf(active) - 0.5} y={0.5} width={barW + 1} height={height - 1} />}
          </svg>
        )}
        {axis && <span className="spark-scale">{format(top)}</span>}
        {active !== null && (
          <span className="tip" style={{ left: tipLeft }}>
            {text(active)}
          </span>
        )}
      </div>
      {labels && labels.length > 2 && (
        <div className="bars-axis" style={{ paddingLeft: pad }} aria-hidden="true">
          <span>{labels[0]}</span>
          <span>{labels[Math.floor(labels.length / 2)]}</span>
          <span>{labels.at(-1)}</span>
        </div>
      )}
    </div>
  );
}
