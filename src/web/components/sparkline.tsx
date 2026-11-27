import { useState, type PointerEvent } from "react";
import { AREA, DOT, p95, SECONDARY, snapDown, SOLID, TRACK } from "../lib/dither";
import { duration } from "../lib/format";
import { dither, useWidth, type Tone } from "./dither";

export type Values = (number | null)[];

/** What a panel needs to draw one graph, whatever the selected range. */
export interface SeriesView {
  values: Values;
  /** Upload under download (mirrored when `mirror`), or peaks above averages. */
  secondary?: Values;
  capacity: number;
  stepSec: number;
}

interface SparklineProps extends SeriesView {
  /** Fixed top of the scale (1 for ratios); otherwise scales to the data. */
  max?: number;
  /** Smallest auto scale, so an idle link doesn't show a 1 B/s axis. */
  minTop?: number;
  format: (value: number) => string;
  height?: number;
  label: string;
  /** Traffic: primary grows up from the middle line, secondary grows down, each on its own scale. */
  mirror?: [string, string];
  tone?: Tone;
  /** Hide the scale label (tiles). */
  bare?: boolean;
  /** Scale to the 95th percentile so one spike doesn't flatten the rest (it is clipped at the top). */
  robust?: boolean;
  /** Take the parent's remaining height (at least `height`) instead of a fixed one. */
  fill?: boolean;
}

function topOf(values: Values | undefined, robust: boolean | undefined, minTop: number): number {
  const known = (values ?? []).filter((v): v is number => v !== null);
  if (robust) return niceTop(Math.max(p95(known) * 1.25, minTop));
  return niceTop(Math.max(finiteMax(values), minTop));
}

export function niceTop(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return nice * magnitude;
}

function finiteMax(values: Values | undefined): number {
  let top = 0;
  for (const value of values ?? []) if (value !== null && value > top) top = value;
  return top;
}

/** A column's value: the peak of its samples, null for missing data, undefined before history starts. */
type Column = number | null | undefined;

/** Puts `values` (the newest `values.length` of `capacity` slots) onto `columns` 2-px columns, keeping peaks. */
function columnsOf(values: Values, capacity: number, columns: number): Column[] {
  const offset = capacity - values.length;
  const out: Column[] = [];
  for (let column = 0; column < columns; column += 1) {
    const from = Math.floor((column * capacity) / columns);
    const to = Math.max(from + 1, Math.floor(((column + 1) * capacity) / columns));
    let peak: Column = undefined;
    for (let slot = from; slot < to; slot += 1) {
      const value = values[slot - offset];
      if (value === undefined) continue;
      if (value === null) peak ??= null;
      else if (peak === null || peak === undefined || value > peak) peak = value;
    }
    out.push(peak);
  }
  return out;
}

/** Path of 2-px columns rising from `base` (or hanging down when `down`). */
/** Pixel height of a value; under one pixel draws nothing, so idle reads as idle instead of a 2 px floor. */
function px(value: number | null | undefined, top: number, span: number): number {
  if (value === null || value === undefined || value <= 0) return 0;
  const raw = (Math.min(value, top) / top) * span;
  return raw < 1 ? 0 : Math.max(DOT, snapDown(raw));
}

function bars(cols: Column[], top: number, base: number, span: number, down = false): string {
  let d = "";
  cols.forEach((value, index) => {
    const h = px(value, top, span);
    if (!h) return;
    const y = down ? base : base - h;
    d += `M${index * DOT} ${y}h${DOT}v${h}h-${DOT}z`;
  });
  return d;
}

function caps(cols: Column[], top: number, base: number, span: number, down = false): string {
  let d = "";
  cols.forEach((value, index) => {
    const h = px(value, top, span);
    if (!h) return;
    const y = down ? base + h - DOT : base - h;
    d += `M${index * DOT} ${y}h${DOT}v${DOT}h-${DOT}z`;
  });
  return d;
}

function gaps(cols: Column[], base: number): string {
  let d = "";
  cols.forEach((value, index) => {
    if (value === null) d += `M${index * DOT} ${base - DOT}h${DOT}v${DOT}h-${DOT}z`;
  });
  return d;
}

function ago(seconds: number): string {
  if (seconds <= 0) return "now";
  return seconds < 60 ? `−${Math.round(seconds)}s` : `−${duration(seconds)}`;
}

/**
 * A dithered column chart drawn at its real pixel size: one 2-px column per slot of width, each column the peak of
 * the samples under it, a solid 2-px top as "the line", and a dotted stub where data is missing.
 */
export function Sparkline({ values, secondary, capacity, stepSec, max, minTop = 0, format, height: fixedHeight = 48, label, mirror, tone = "ink", bare, robust, fill }: SparklineProps) {
  const [ref, width, boxHeight] = useWidth<HTMLDivElement>();
  const height = fill ? Math.max(fixedHeight, snapDown(boxHeight)) : fixedHeight;
  const [hover, setHover] = useState<number | null>(null);
  const columns = Math.max(1, Math.floor(width / DOT));
  const w = columns * DOT;

  const primary = columnsOf(values, capacity, columns);
  const second = secondary ? columnsOf(secondary, capacity, columns) : null;
  const topA = max ?? (mirror ? topOf(values, robust, minTop) : Math.max(topOf(values, robust, minTop), robust ? 0 : topOf(secondary, false, minTop)));
  const topB = mirror ? (max ?? topOf(secondary, robust, minTop)) : topA;

  const half = snapDown(height / 2);
  const base = mirror ? half : height;
  const span = mirror ? half - 1 : height - DOT;

  function onPointerMove(event: PointerEvent<HTMLDivElement>): void {
    const rect = event.currentTarget.getBoundingClientRect();
    const column = Math.floor((event.clientX - rect.left) / DOT);
    setHover(column >= 0 && column < columns ? column : null);
  }

  // Map the hovered column back to the newest sample under it, for the readout.
  const slot = hover === null ? null : Math.min(capacity - 1, Math.floor(((hover + 1) * capacity) / columns) - 1);
  const index = slot === null ? null : slot - (capacity - values.length);
  const hovered = index !== null && index >= 0 ? values[index] : undefined;
  const hoveredSecondary = index !== null && index >= 0 ? secondary?.[index] : undefined;

  return (
    <div
      ref={ref}
      className={`spark${fill ? " is-fill" : ""}`}
      style={fill ? { minHeight: fixedHeight } : { height }}
      onPointerMove={onPointerMove}
      onPointerLeave={() => setHover(null)}
      role="img"
      aria-label={`${label}, last ${duration(capacity * stepSec)}`}
    >
      {width > 0 && (
        <svg width={w} height={height} viewBox={`0 0 ${w} ${height}`} shapeRendering="crispEdges" aria-hidden="true">
          {mirror ? (
            <>
              <path d={bars(primary, topA, base, span)} fill={dither(AREA, tone)} />
              <path d={caps(primary, topA, base, span)} fill={dither(SOLID, tone)} />
              {second && <path d={bars(second, topB, base + 1, span, true)} fill={dither(AREA, tone)} />}
              {second && <path d={caps(second, topB, base + 1, span, true)} fill={dither(SOLID, tone)} />}
              <rect className="spark-axis" y={base} width={w} height={1} />
            </>
          ) : (
            <>
              {second && <path d={bars(second, topA, base, span)} fill={dither(SECONDARY, tone)} />}
              <path d={bars(primary, topA, base, span)} fill={dither(AREA, tone)} />
              <path d={caps(primary, topA, base, span)} fill={dither(SOLID, tone)} />
            </>
          )}
          <path d={gaps(primary, mirror ? base : height)} fill={dither(TRACK)} />
          {hover !== null && <rect className="spark-cursor" x={hover * DOT} width={DOT} height={height} />}
        </svg>
      )}
      {!bare && <span className="spark-scale">{mirror ? `${mirror[0]} ${format(topA)}` : format(topA)}</span>}
      {!bare && mirror && <span className="spark-scale spark-scale-low">{`${mirror[1]} ${format(topB)}`}</span>}
      {hover !== null && !bare && (
        <span className="spark-readout">
          {hovered === null || hovered === undefined ? "no data" : format(hovered)}
          {hoveredSecondary !== null && hoveredSecondary !== undefined && ` · ${format(hoveredSecondary)}`}
          <span className="muted"> {ago((values.length - 1 - (index ?? 0)) * stepSec)}</span>
        </span>
      )}
    </div>
  );
}
