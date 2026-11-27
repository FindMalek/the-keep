import { expect, test } from "bun:test";
import { parseRange } from "./garage-s3";

test("byte ranges clamp to the object and ignore what they can't serve", () => {
  expect(parseRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
  expect(parseRange("bytes=900-", 1000)).toEqual({ start: 900, end: 999 });
  expect(parseRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
  expect(parseRange("bytes=0-5000", 1000)).toEqual({ start: 0, end: 999 });
  expect(parseRange("bytes=2000-", 1000)).toBeNull();
  expect(parseRange("bytes=0-1,5-9", 1000)).toBeNull();
});
