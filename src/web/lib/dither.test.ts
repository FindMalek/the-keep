import { describe, expect, test } from "bun:test";
import { densityLevel, heatStep, inkAlpha, level, onPixels, peaks, SOLID, TRACK } from "./dither";

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

  test("density squares use five distinct steps and put any value above the empty track", () => {
    expect(densityLevel(0)).toBe(TRACK);
    expect(heatStep(0.01)).toBe(1);
    expect(heatStep(0.25)).toBe(1);
    expect(heatStep(0.26)).toBe(2);
    expect(heatStep(1)).toBe(4);
    expect(heatStep(5)).toBe(4);
    expect(new Set([0, 0.1, 0.4, 0.6, 0.9].map(densityLevel)).size).toBe(5);
    expect(densityLevel(1)).toBe(SOLID);
  });

  test("ink gets lighter as density drops", () => {
    expect(inkAlpha(TRACK)).toBeLessThan(inkAlpha(8));
    expect(inkAlpha(8)).toBeLessThan(inkAlpha(12));
    expect(inkAlpha(SOLID)).toBe(1);
  });

  test("peaks keeps each bucket's maximum and leaves gaps as gaps", () => {
    expect(peaks([1, 5, 2, 2, null, null], 3)).toEqual([5, 2, null]);
    expect(peaks([1, 2], 4)).toEqual([1, 2]);
  });
});
