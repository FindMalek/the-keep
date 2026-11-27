/** Folds a series into `count` buckets, each the average of its non-null values (null when it has none). */
export function fold(values: (number | null)[], count: number): (number | null)[] {
  if (!values.length) return Array(count).fill(null);
  return Array.from({ length: count }, (_, bucket) => {
    const from = Math.floor((bucket * values.length) / count);
    const to = Math.max(from + 1, Math.floor(((bucket + 1) * values.length) / count));
    let sum = 0;
    let n = 0;
    for (let index = from; index < to; index += 1) {
      const value = values[index];
      if (value !== null && value !== undefined) {
        sum += value;
        n += 1;
      }
    }
    return n ? sum / n : null;
  });
}

/** Average of the known buckets; null when nothing is known. */
export function mean(values: (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length ? known.reduce((sum, value) => sum + value, 0) / known.length : null;
}
