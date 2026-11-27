/** 4×4 ordered (Bayer) dither: a pixel at (x mod 4, y mod 4) is on at level L when BAYER[y][x] < L. */
export const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
] as const;

export const LEVELS = 16;
/** One dither dot in CSS px; a pattern tile is 4 dots. */
export const DOT = 2;

/** Fixed densities used across the system. */
export const TRACK = 2;
export const SECONDARY = 5;
export const AREA = 8;
export const FILL = 12;
export const SOLID = 16;

/** 0..1 → 0..16; any value above zero shows at least one dot. */
export function level(value: number): number {
  if (!(value > 0)) return 0;
  return Math.min(LEVELS, Math.max(1, Math.round(value * LEVELS)));
}

/**
 * For squares whose density is the value (heat, space, day maps): zero is the TRACK texture, and any non-zero value
 * starts one step above it so "a little" never looks emptier than "nothing". Above that it is the plain 0..16 scale,
 * so 14% and 24% stay two levels apart.
 */
export function densityLevel(value: number): number {
  if (!(value > 0)) return TRACK;
  return Math.max(TRACK + 1, level(value));
}

/** The on-pixels of one 4×4 tile at a level, as [x, y]. */
export function onPixels(lvl: number): [number, number][] {
  const pixels: [number, number][] = [];
  BAYER.forEach((row, y) => row.forEach((threshold, x) => threshold < lvl && pixels.push([x, y])));
  return pixels;
}

/** Rounds to the dot grid so dots never split. */
export const snap = (value: number): number => Math.round(value / DOT) * DOT;
export const snapDown = (value: number): number => Math.floor(value / DOT) * DOT;

/** Squeezes `values` into `columns` buckets, keeping each bucket's peak; all-null buckets stay null. */
export function peaks(values: (number | null)[], columns: number): (number | null)[] {
  if (columns <= 0) return [];
  if (values.length <= columns) return values;
  const out: (number | null)[] = [];
  for (let column = 0; column < columns; column += 1) {
    const from = Math.floor((column * values.length) / columns);
    const to = Math.max(from + 1, Math.floor(((column + 1) * values.length) / columns));
    let peak: number | null = null;
    for (let index = from; index < to; index += 1) {
      const value = values[index];
      if (value !== null && value !== undefined && (peak === null || value > peak)) peak = value;
    }
    out.push(peak);
  }
  return out;
}

/** The 95th percentile of the non-zero values, so one huge day doesn't flatten the rest of a heatmap. */
export function p95(values: number[]): number {
  const sorted = values.filter((value) => value > 0).sort((a, b) => a - b);
  if (!sorted.length) return 1;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 1;
}
