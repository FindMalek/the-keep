import { expect, test } from "bun:test";
import { bucketResponse, countPrefix, parseDelete, parseRange } from "./garage-s3";

test("byte ranges clamp to the object and ignore what they can't serve", () => {
  expect(parseRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
  expect(parseRange("bytes=900-", 1000)).toEqual({ start: 900, end: 999 });
  expect(parseRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
  expect(parseRange("bytes=0-5000", 1000)).toEqual({ start: 0, end: 999 });
  expect(parseRange("bytes=2000-", 1000)).toBeNull();
  expect(parseRange("bytes=0-1,5-9", 1000)).toBeNull();
});

const fake = (objects: { key: string; size: number }[], removed: string[] = []) => ({
  list: async () => ({ prefixes: [], objects: [], next: null }),
  get: async () => null,
  async *walk(_bucket: string, prefix: string) {
    const matching = objects.filter((o) => o.key.startsWith(prefix)).map((o) => ({ ...o, modified: 0, etag: null }));
    // Two pages, as S3 would hand them back.
    yield matching.slice(0, 2);
    if (matching.length > 2) yield matching.slice(2);
  },
  remove: async (_bucket: string, keys: string[]) => (removed.push(...keys), { deleted: keys.length, failed: [] }),
});
const objects = [
  { key: "a/1", size: 10 },
  { key: "a/b/2", size: 20 },
  { key: "a/b/3", size: 30 },
  { key: "c/4", size: 40 },
];
const post = (bucket: string, body: unknown, header = true) =>
  new Request(`http://x/api/buckets/${bucket}/delete`, { method: "POST", headers: header ? { "x-keep-action": "1" } : {}, body: JSON.stringify(body) });

test("a prefix total counts every object below it across pages", async () => {
  expect(await countPrefix(fake(objects), "b", "a/")).toEqual({ objects: 3, bytes: 60, capped: false });
  expect(await countPrefix(fake(objects), "b", "")).toEqual({ objects: 4, bytes: 100, capped: false });
  expect((await countPrefix(fake(objects), "b", "", 2)).capped).toBe(true);
});

test("deletes are refused outside the allowlist, on photos and backups even when listed, and without a write key", async () => {
  const names = ["turbo-cache", "ente", "skiffr-backups"];
  const allowed = ["turbo-cache", "ente", "skiffr-backups"];
  for (const bucket of ["ente", "skiffr-backups"]) {
    const removed: string[] = [];
    const response = await bucketResponse(fake(objects, removed), names, post(bucket, { keys: ["a/1"] }), { allowed });
    expect(response.status).toBe(403);
    expect(removed).toEqual([]);
  }
  expect((await bucketResponse(fake(objects), names, post("turbo-cache", { keys: ["a/1"] }), { allowed: [] })).status).toBe(403);
  const readOnly = { ...fake(objects), remove: undefined };
  expect((await bucketResponse(readOnly, names, post("turbo-cache", { keys: ["a/1"] }), { allowed })).status).toBe(403);
  expect((await bucketResponse(fake(objects), names, post("turbo-cache", { keys: ["a/1"] }, false), { allowed })).status).toBe(403);
});

test("a folder delete needs its name typed and removes everything under it", async () => {
  const removed: string[] = [];
  const source = fake(objects, removed);
  const write = { allowed: ["turbo-cache"] };
  expect((await bucketResponse(source, ["turbo-cache"], post("turbo-cache", { prefixes: ["a/"] }), write)).status).toBe(400);
  expect((await bucketResponse(source, ["turbo-cache"], post("turbo-cache", { prefixes: [""] , confirm: "turbo-cache" }), write)).status).toBe(400);
  const response = await bucketResponse(source, ["turbo-cache"], post("turbo-cache", { prefixes: ["a/"], confirm: "a" }), write);
  expect(await response.json()).toEqual({ deleted: 3, bytes: 60, failed: [] });
  expect(removed.sort()).toEqual(["a/1", "a/b/2", "a/b/3"]);
  expect(parseDelete("turbo-cache", { keys: ["a/1", "c/4"], confirm: "a" })).toBe("type turbo-cache to confirm");
});
