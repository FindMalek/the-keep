import { S3Client } from "bun";
import type { ActionRecord, BucketDeleteResult, BucketListing, BucketObject, PrefixTotal } from "../shared/types";

export interface ByteRange {
  start: number;
  /** Inclusive, as in the HTTP header. */
  end: number;
}

export interface BucketSource {
  list(bucket: string, prefix: string, after: string | null, limit: number): Promise<BucketListing>;
  /** `size` is the whole object's; `body` is only the range when one is given. */
  get(bucket: string, key: string, range?: ByteRange): Promise<{ body: ReadableStream | Blob; size: number; type: string } | null>;
  /** Every object under `prefix`, recursively, a page at a time. */
  walk(bucket: string, prefix: string): AsyncIterable<BucketObject[]>;
  /** Only present when a write key is configured. */
  remove?(bucket: string, keys: string[]): Promise<{ deleted: number; failed: string[] }>;
}

export interface GarageS3Config {
  url: string;
  key: string;
  secret: string;
  region: string;
  /** A second key with write grants on the cleanable buckets only; listing never uses it. */
  writeKey?: { key: string; secret: string } | null;
}

/** Browsing through Garage's S3 API (its admin API can't list objects) with a read-only key; deletes use a separate key. */
export function createGarageS3(config: GarageS3Config): BucketSource {
  const client = (bucket: string, key = config.key, secret = config.secret) =>
    new S3Client({ endpoint: config.url, accessKeyId: key, secretAccessKey: secret, region: config.region, bucket, virtualHostedStyle: false });
  const writer = config.writeKey;

  return {
    async list(bucket, prefix, after, limit) {
      const response = await client(bucket).list({ prefix, delimiter: "/", maxKeys: limit, startAfter: after ?? undefined });
      const objects = (response.contents ?? []).map((object) => ({
        key: object.key,
        size: object.size ?? 0,
        modified: object.lastModified ? Date.parse(object.lastModified) : 0,
        etag: object.eTag ?? null,
      }));
      return {
        // S3 repeats common prefixes on every page; only the first page shows folders.
        prefixes: after ? [] : (response.commonPrefixes ?? []).map((entry) => entry.prefix),
        objects,
        next: response.isTruncated ? (objects.at(-1)?.key ?? null) : null,
      };
    },
    async get(bucket, key, range) {
      const file = client(bucket).file(key);
      const stat = await file.stat().catch(() => null);
      if (!stat) return null;
      const body = range ? file.slice(range.start, range.end + 1).stream() : file.stream();
      return { body, size: stat.size, type: stat.type || "application/octet-stream" };
    },
    async *walk(bucket, prefix) {
      let after: string | undefined;
      for (;;) {
        const response = await client(bucket).list({ prefix, maxKeys: 1000, startAfter: after });
        const page = (response.contents ?? []).map((object) => ({
          key: object.key,
          size: object.size ?? 0,
          modified: object.lastModified ? Date.parse(object.lastModified) : 0,
          etag: object.eTag ?? null,
        }));
        if (page.length) yield page;
        if (!response.isTruncated || !page.length) return;
        after = page.at(-1)!.key;
      }
    },
    ...(writer
      ? {
          async remove(bucket: string, keys: string[]) {
            const s3 = client(bucket, writer.key, writer.secret);
            const failed: string[] = [];
            let next = 0;
            // Bun's client has no batch delete; a few at a time keeps Garage responsive.
            await Promise.all(
              Array.from({ length: Math.min(16, keys.length) }, async () => {
                while (next < keys.length) {
                  const key = keys[next++]!;
                  await s3.delete(key).catch(() => failed.push(key));
                }
              }),
            );
            return { deleted: keys.length - failed.length, failed };
          },
        }
      : {}),
  };
}

/** Counting stops here: a total is for "how big is this folder", not an inventory. */
export const TOTAL_CAP = 250_000;
const TOTAL_TTL_MS = 60_000;
const totals = new Map<string, { at: number; total: Promise<PrefixTotal> }>();

/** Adds up every object under a prefix; `cap` bounds the walk on huge buckets. */
export async function countPrefix(source: BucketSource, bucket: string, prefix: string, cap = TOTAL_CAP): Promise<PrefixTotal> {
  const total: PrefixTotal = { objects: 0, bytes: 0, capped: false };
  for await (const page of source.walk(bucket, prefix)) {
    for (const object of page) {
      total.objects += 1;
      total.bytes += object.size;
    }
    if (total.objects >= cap) return { ...total, capped: true };
  }
  return total;
}

function cachedTotal(source: BucketSource, bucket: string, prefix: string): Promise<PrefixTotal> {
  const name = `${bucket}\0${prefix}`;
  const hit = totals.get(name);
  if (hit && Date.now() - hit.at < TOTAL_TTL_MS) return hit.total;
  const total = countPrefix(source, bucket, prefix);
  totals.set(name, { at: Date.now(), total });
  total.catch(() => totals.delete(name));
  return total;
}

/**
 * Buckets that must never be cleaned from the dashboard, whatever the config says: photos and backups.
 * A typo in the allowlist or a key with too many grants still can't reach them.
 */
const NEVER = /^(ente|skiffr)|backup/i;

/** Why deletes are off for a bucket, or null when they are allowed. */
export function deleteLock(bucket: string, allowed: string[], writable: boolean): string | null {
  if (NEVER.test(bucket)) return "never cleaned from here: photos and backups";
  if (!allowed.includes(bucket)) return "not in GARAGE_S3_DELETE_BUCKETS";
  if (!writable) return "no write key: set GARAGE_S3_RW_KEY and GARAGE_S3_RW_SECRET";
  return null;
}

export interface DeleteRequest {
  keys: string[];
  prefixes: string[];
  confirm: string;
}

/** What the person must type: the folder's name for one folder, the bucket's for several items; nothing for one object. */
export function confirmationFor(bucket: string, keys: string[], prefixes: string[]): string | null {
  if (prefixes.length === 1 && keys.length === 0) return prefixes[0]!.split("/").filter(Boolean).at(-1) ?? bucket;
  if (prefixes.length + keys.length > 1) return bucket;
  return null;
}

/** Shape and confirmation check for a delete body; returns the request or the reason it is refused. */
export function parseDelete(bucket: string, body: unknown): DeleteRequest | string {
  const value = body as Partial<Record<keyof DeleteRequest, unknown>> | null;
  const strings = (list: unknown) => (Array.isArray(list) && list.every((item) => typeof item === "string" && item.length > 0 && item.length < 1024) ? (list as string[]) : null);
  const keys = value?.keys === undefined ? [] : strings(value.keys);
  const prefixes = value?.prefixes === undefined ? [] : strings(value.prefixes);
  if (!keys || !prefixes) return "keys and prefixes must be lists of names";
  if (keys.length + prefixes.length === 0) return "nothing to delete";
  if (keys.length > 1000 || prefixes.length > 100) return "too many items in one delete";
  // An empty or root prefix would empty the bucket.
  if (prefixes.some((prefix) => !prefix.endsWith("/") || prefix === "/")) return "folders end with /";
  const required = confirmationFor(bucket, keys, prefixes);
  const confirm = typeof value?.confirm === "string" ? value.confirm.trim() : "";
  if (required !== null && confirm !== required) return `type ${required} to confirm`;
  return { keys, prefixes, confirm };
}

export interface BucketWriteOptions {
  allowed: string[];
  log?: (record: ActionRecord) => void;
  requester?: string | null;
}

async function deleteObjects(source: BucketSource, bucket: string, request: DeleteRequest): Promise<BucketDeleteResult> {
  const keys = new Set(request.keys);
  let bytes = 0;
  for (const prefix of request.prefixes) {
    for await (const page of source.walk(bucket, prefix)) {
      for (const object of page) if (!keys.has(object.key)) (keys.add(object.key), (bytes += object.size));
    }
  }
  const result = await source.remove!(bucket, [...keys]);
  for (const name of totals.keys()) if (name.startsWith(`${bucket}\0`)) totals.delete(name);
  return { ...result, bytes, failed: result.failed.slice(0, 50) };
}

const PREVIEW_LIMIT = 25 * 1024 * 1024;
/** Audio and video stream in ranges, so they can be any size. */
const STREAMED = /^(audio|video)\//;

/** One `bytes=a-b` range (or `a-`, or `-n`); anything else is served whole. */
export function parseRange(header: string | null, size: number): ByteRange | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return start <= end && start < size ? { start, end } : null;
}
const SAFE_INLINE = /^(image\/(png|jpe?g|gif|webp|avif)|audio\/|video\/|application\/pdf)/;

/** /api/buckets/<name>/list, /object, /total (GET) and /delete (POST). Only bucket names Garage reported are accepted. */
export async function bucketResponse(source: BucketSource, names: string[], request: Request, write: BucketWriteOptions = { allowed: [] }): Promise<Response> {
  const url = new URL(request.url);
  const match = /^\/api\/buckets\/([^/]+)\/(list|object|total|delete)$/.exec(url.pathname);
  const bucket = match?.[1] ? decodeURIComponent(match[1]) : null;
  if (!match || !bucket || !names.includes(bucket)) return new Response("unknown bucket", { status: 404 });
  const lock = deleteLock(bucket, write.allowed, !!source.remove);
  try {
    if (match[2] === "delete") {
      if (request.method !== "POST") return new Response("POST only", { status: 405 });
      // A custom header forces a CORS preflight, so other sites can't trigger deletes from your browser.
      if (request.headers.get("x-keep-action") !== "1") return new Response("missing header", { status: 403 });
      if (lock) return new Response(`deletes are off for ${bucket}: ${lock}`, { status: 403 });
      const parsed = parseDelete(bucket, await request.json().catch(() => null));
      if (typeof parsed === "string") return new Response(parsed, { status: 400 });
      const started = Date.now();
      const result = await deleteObjects(source, bucket, parsed);
      const what = [...parsed.prefixes, ...parsed.keys];
      write.log?.({
        action: "bucket-delete",
        at: new Date().toISOString(),
        status: result.failed.length ? "failed" : "done",
        detail: `${bucket}: ${what.length === 1 ? what[0] : `${what.length} items`} · ${result.deleted} objects${result.bytes ? ` · ${result.bytes} bytes` : ""}${result.failed.length ? ` · ${result.failed.length} failed` : ""}`,
        requestedBy: write.requester ?? null,
        startedAt: new Date(started).toISOString(),
        durationSec: Math.round((Date.now() - started) / 1000),
        freedBytes: result.bytes || null,
      });
      return Response.json(result);
    }
    if (match[2] === "total") return Response.json(await cachedTotal(source, bucket, url.searchParams.get("prefix") ?? ""));
    if (match[2] === "list") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 200) || 200));
      const listing: BucketListing = await source.list(bucket, prefix, url.searchParams.get("after"), limit);
      return Response.json({ ...listing, deletable: lock === null, locked: lock });
    }
    const key = url.searchParams.get("key") ?? "";
    const head = key ? await source.get(bucket, key, { start: 0, end: 0 }) : null;
    if (!head) return new Response("not found", { status: 404 });
    const range = parseRange(request.headers.get("range"), head.size);
    const object = range ? await source.get(bucket, key, range) : await source.get(bucket, key);
    if (!object) return new Response("not found", { status: 404 });
    const download = url.searchParams.get("download") === "1";
    if (!download && !range && !STREAMED.test(object.type) && object.size > PREVIEW_LIMIT) return new Response("too large to preview", { status: 413 });
    const name = key.split("/").at(-1) ?? "file";
    // Anything that could run script (html, svg) is sent as a download, never rendered on this origin.
    const textual = /^text\/|json|yaml|toml|xml|javascript/.test(object.type);
    const inline = !download && (SAFE_INLINE.test(object.type) || textual);
    const type = !inline ? "application/octet-stream" : textual ? "text/plain; charset=utf-8" : object.type;
    const headers: Record<string, string> = {
      "content-type": type,
      "content-length": String(range ? range.end - range.start + 1 : object.size),
      "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
      "accept-ranges": "bytes",
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=300",
    };
    // Even if a type slipped through, the response can't run script or load anything. Chrome's PDF viewer refuses
    // to render under `sandbox`, so PDFs get the resource lock without it.
    headers["content-security-policy"] = type === "application/pdf" ? "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'" : "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'";
    if (range) headers["content-range"] = `bytes ${range.start}-${range.end}/${object.size}`;
    return new Response(object.body, { status: range ? 206 : 200, headers });
  } catch (error) {
    return new Response(error instanceof Error ? error.message : "s3 error", { status: 502 });
  }
}
