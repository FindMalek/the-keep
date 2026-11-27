import { useEffect, useRef, useState, type RefObject } from "react";
import { DOT, onPixels, SOLID } from "../lib/dither";

const TONES = { ink: "var(--ink)", warn: "var(--warn)", crit: "var(--crit)", muted: "var(--muted)" } as const;
export type Tone = keyof typeof TONES;

let solidOnly = false;

/**
 * Patterns for every tone and level, mounted once. userSpaceOnUse anchors each pattern to the origin of the SVG that
 * uses it, so neighbouring bars in one chart share a phase and the texture runs continuously across them.
 */
export function DitherDefs() {
  const [, setContrast] = useState(0);
  useEffect(() => {
    const query = window.matchMedia("(prefers-contrast: more)");
    const update = () => {
      solidOnly = query.matches;
      setContrast((n) => n + 1);
    };
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  const size = DOT * 4;
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
      <defs>
        {(Object.keys(TONES) as Tone[]).flatMap((tone) =>
          Array.from({ length: SOLID - 1 }, (_, index) => index + 1).map((lvl) => (
            <pattern key={`${tone}-${lvl}`} id={`d-${tone}-${lvl}`} width={size} height={size} patternUnits="userSpaceOnUse">
              {onPixels(lvl).map(([x, y]) => (
                <rect key={`${x}-${y}`} x={x * DOT} y={y * DOT} width={DOT} height={DOT} style={{ fill: TONES[tone] }} />
              ))}
            </pattern>
          )),
        )}
      </defs>
    </svg>
  );
}

/** Fill for an SVG shape: a dither level 0..16 in a tone. 16 is plain solid ink. */
export function dither(lvl: number, tone: Tone = "ink"): string {
  if (lvl <= 0) return "none";
  if (lvl >= SOLID || solidOnly) return TONES[tone];
  return `url(#d-${tone}-${Math.round(lvl)})`;
}

/** Content width and height of an element in whole CSS px, kept current with a ResizeObserver. */
export function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number, number] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = (width: number, height: number) =>
      setSize((current) => (current.width === Math.floor(width) && current.height === Math.floor(height) ? current : { width: Math.floor(width), height: Math.floor(height) }));
    const observer = new ResizeObserver(([entry]) => entry && update(entry.contentRect.width, entry.contentRect.height));
    observer.observe(element);
    const rect = element.getBoundingClientRect();
    update(rect.width, rect.height);
    return () => observer.disconnect();
  }, []);
  return [ref, size.width, size.height];
}
