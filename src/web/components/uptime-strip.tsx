import { useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { DOT, FILL, level, snapDown, SOLID, TRACK } from "../lib/dither";
import { dither, useWidth } from "./dither";

interface UptimeStripProps {
  /** Share of time up per bucket, oldest first; null when nothing was recorded. */
  values: (number | null)[];
  height?: number;
  label: string;
  /** Tooltip for a bucket. */
  describe: (index: number) => ReactNode;
  onHover?: (index: number | null) => void;
  onPick?: (index: number) => void;
}


/** Dense ink when up, warn dither that thins as it goes down, solid crit when fully down, dotted track when unknown. */
export function UptimeStrip({ values, height = 16, label, describe, onHover, onPick }: UptimeStripProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const n = values.length;
  // Cells run edge to edge on the 2 px grid; some are a dot wider, which a continuous texture hides.
  const xOf = (index: number) => snapDown((index * width) / Math.max(1, n));
  const widthOf = (index: number) => Math.max(DOT, (index === n - 1 ? width : xOf(index + 1)) - xOf(index));
  const cellW = width / Math.max(1, n);

  const set = (index: number | null) => {
    setActive(index);
    onHover?.(index);
  };

  function onPointerMove(event: PointerEvent<HTMLDivElement>): void {
    const x = event.clientX - event.currentTarget.getBoundingClientRect().left;
    const index = Math.floor(x / cellW);
    set(index >= 0 && index < n ? index : null);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    set(Math.max(0, Math.min(n - 1, (active ?? n - 1) + (event.key === "ArrowRight" ? 1 : -1))));
  }

  const tipLeft = active === null ? 0 : Math.min(Math.max(0, xOf(active) - 60), Math.max(0, width - 220));

  return (
    <div
      ref={ref}
      className="strip"
      style={{ height }}
      tabIndex={0}
      role="img"
      aria-label={label}
      onPointerMove={onPointerMove}
      onPointerLeave={() => set(null)}
      onBlur={() => set(null)}
      onKeyDown={onKeyDown}
      onClick={() => active !== null && onPick?.(active)}
    >
      {width > 0 && (
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} shapeRendering="crispEdges" aria-hidden="true">
          {values.map((value, index) => {
            const fill =
              value === null ? dither(TRACK) : value >= 0.999 ? dither(FILL) : value <= 0 ? dither(SOLID, "crit") : dither(Math.max(3, Math.min(10, level(value) - 4)), "warn");
            return <rect key={index} x={xOf(index)} width={widthOf(index)} height={height} fill={fill} />;
          })}
          {active !== null && <rect className="bars-cursor" x={xOf(active) + 0.5} y={0.5} width={widthOf(active) - 1} height={height - 1} />}
        </svg>
      )}
      {active !== null && (
        <span className="tip tip-below" style={{ left: tipLeft }}>
          {describe(active)}
        </span>
      )}
    </div>
  );
}
