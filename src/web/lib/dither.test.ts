import { describe, expect, test } from "bun:test";
import { densityLevel, level, onPixels, peaks, TRACK } from "./dither";

describe("dither", () => {
  test("level maps 0..1 onto 17 densities and never hides a non-zero value", () => {
    expect(level(0)).toBe(0);
    expect(level(0.001)).toBe(1);
    expect(level(0.5)).toBe(8);
    expect(level(1)).toBe(16);
    expect(level(3)).toBe(16);
  });

  test("each level turns on exactly that many pixels of the tile", () => {
    for (let lvl = 0; lvl <= 16; lvl += 1) expect(onPixels(lvl)).toHaveLength(lvl);
  });

  test("density squares put any value above the empty track", () => {
    expect(densityLevel(0)).toBe(TRACK);
    expect(densityLevel(0.01)).toBeGreaterThan(TRACK);
    expect(densityLevel(1)).toBe(16);
    expect(densityLevel(0.5) - densityLevel(0.25)).toBe(4);
  });

  test("peaks keeps each bucket's maximum and leaves gaps as gaps", () => {
    expect(peaks([1, 5, 2, 2, null, null], 3)).toEqual([5, 2, null]);
    expect(peaks([1, 2], 4)).toEqual([1, 2]);
  });
});
