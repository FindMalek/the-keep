import { useState, type ReactNode } from "react";
import { densityLevel, HEAT_STEPS, p95 } from "../lib/dither";
import { dither, type Tone } from "./dither";

export interface HeatCellProps {
  label?: ReactNode;
  /** 0..1 density. */
  value: number;
  text?: ReactNode;
  tone?: Tone;
  href?: string;
  title?: string;
  /** A solid corner: the app enforces this limit itself. */
  notch?: boolean;
  size?: number;
  /** Outline it as the current or picked one. */
  active?: boolean;
}

/** A square whose dither density is the value; label above, value below. */
export function HeatCell({ label, value, text, tone = "ink", href, title, notch, size = 24, active }: HeatCellProps) {
  const square = (
    <svg className="heat-square" width={size} height={size} viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges" aria-hidden="true">
      <rect width={size} height={size} fill={dither(densityLevel(value), tone)} />
      {notch && <rect x={size - 6} width={6} height={6} fill={dither(16, tone)} />}
    </svg>
  );
  const body = (
    <>
      {label !== undefined && <span className="heat-label">{label}</span>}
      {square}
      {text !== undefined && <span className={`heat-text${tone === "ink" ? "" : ` level-${tone}`}`}>{text}</span>}
    </>
  );
  const className = `heat-cell${active ? " is-active" : ""}`;
  if (href) {
    const external = /^https?:/.test(href);
    return (
      <a className={`${className} is-link`} href={href} title={title} target={external ? "_blank" : undefined} rel={external ? "noreferrer" : undefined}>
        {body}
      </a>
    );
  }
  return (
    <span className={className} title={title}>
      {body}
    </span>
  );
}

interface HeatMatrixProps {
  /** rows × columns of raw values; null is "no data". */
  matrix: (number | null)[][];
  rowLabels: string[];
  columnLabels: string[];
  /** Value that maps to full density; defaults to the largest. */
  scale?: number;
  cell?: number;
  gap?: number;
  tip: (row: number, column: number) => string;
  onPick?: (row: number, column: number) => void;
  picked?: [number, number] | null;
  label: string;
  /** Prints the five-step legend with value ranges. */
  format?: (value: number) => string;
}

/** A GitHub-style grid of dithered squares (days × weeks, days × hours). */
export function HeatMatrix({ matrix, rowLabels, columnLabels, scale, cell = 12, gap = 2, tip, onPick, picked, label, format }: HeatMatrixProps) {
  const [hover, setHover] = useState<[number, number] | null>(null);
  const columns = Math.max(0, ...matrix.map((row) => row.length));
  const top = scale ?? p95(matrix.flat().filter((v): v is number => v !== null));
  const width = columns * (cell + gap) - gap;
  const height = matrix.length * (cell + gap) - gap;
  const shown = hover ?? picked ?? null;

  return (
    <div className="matrix" role="img" aria-label={label}>
      <div className="matrix-columns" style={{ marginLeft: 40, width, gridTemplateColumns: `repeat(${columns}, ${cell + gap}px)` }} aria-hidden="true">
        {columnLabels.map((text, index) => (
          <span key={index}>{text}</span>
        ))}
      </div>
      <div className="matrix-body">
        <div className="matrix-rows" style={{ gridTemplateRows: `repeat(${matrix.length}, ${cell + gap}px)`, lineHeight: `${cell}px` }} aria-hidden="true">
          {rowLabels.map((text, index) => (
            <span key={index}>{text}</span>
          ))}
        </div>
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          shapeRendering="crispEdges"
          onPointerLeave={() => setHover(null)}
          className={onPick ? "is-pickable" : undefined}
        >
          {matrix.map((row, r) =>
            row.map((value, c) => (
              <rect
                key={`${r}-${c}`}
                x={c * (cell + gap)}
                y={r * (cell + gap)}
                width={cell}
                height={cell}
                fill={value === null ? "none" : dither(densityLevel(value / top))}
                className={value === null ? "matrix-empty" : undefined}
                onPointerEnter={() => setHover([r, c])}
                onClick={() => onPick?.(r, c)}
              />
            )),
          )}
          {shown && <rect className="matrix-cursor" x={shown[1] * (cell + gap) - 1.5} y={shown[0] * (cell + gap) - 1.5} width={cell + 3} height={cell + 3} />}
        </svg>
      </div>
      <div className="matrix-foot">
        <div className="matrix-tip">{shown ? tip(shown[0], shown[1]) : " "}</div>
        {format && <HeatScale top={top} format={format} />}
      </div>
    </div>
  );
}

/** The five heat steps as a legend: each square says which values it stands for. */
export function HeatScale({ top, format, size = 10 }: { top: number; format: (value: number) => string; size?: number }) {
  const range = (step: number) => (step === 0 ? "none" : step === 4 ? `over ${format((top * 3) / 4)}` : `up to ${format((top * step) / 4)}`);
  return (
    <span className="heat-scale" aria-label={`scale: ${HEAT_STEPS.map((_, step) => range(step)).join(", ")}`}>
      <span>0</span>
      {HEAT_STEPS.map((lvl, step) => (
        <svg key={step} width={size} height={size} viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges" aria-hidden="true">
          <title>{range(step)}</title>
          <rect width={size} height={size} fill={dither(lvl)} />
        </svg>
      ))}
      <span>{format(top)}+</span>
    </span>
  );
}
