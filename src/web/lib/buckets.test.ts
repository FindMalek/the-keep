import { expect, test } from "bun:test";
import { fold, mean } from "./buckets";

test("fold averages known values per bucket and keeps unknown buckets null", () => {
  expect(fold([1, 0, null, null, 1, 1], 3)).toEqual([0.5, null, 1]);
  expect(fold([], 2)).toEqual([null, null]);
});

test("mean ignores buckets with no data", () => {
  expect(mean([1, null, 0.5])).toBe(0.75);
  expect(mean([null])).toBeNull();
});
