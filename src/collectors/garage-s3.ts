import { S3Client } from "bun";
import type { BucketListing } from "../shared/types";

export interface ByteRange {
  start: number;
  /** Inclusive, as in the HTTP header. */
  end: number;
}

export interface BucketSource {
  list(bucket: string, prefix: string, after: string | null, limit: number): Promise<BucketListing>;
  /** `size` is the whole object's; `body` is only the range when one is given. */
  get(bucket: string, key: string, range?: ByteRange): Promise<{ body: ReadableStream | Blob; size: number; type: string } | null>;
}

export interface GarageS3Config {
  url: string;
  key: string;
  secret: string;
  region: string;
}

/** Read-only browsing through Garage's S3 API (its admin API can't list objects). The key only has read grants. */
export function createGarageS3(config: GarageS3Config): BucketSource {
  const client = (bucket: string) =>
    new S3Client({ endpoint: config.url, accessKeyId: config.key, secretAccessKey: config.secret, region: config.region, bucket, virtualHostedStyle: false });

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
  };
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

/** GET /api/buckets/<name>/list and /object. Only bucket names Garage reported are accepted. */
export async function bucketResponse(source: BucketSource, names: string[], request: Request): Promise<Response> {
  const url = new URL(request.url);
  const match = /^\/api\/buckets\/([^/]+)\/(list|object)$/.exec(url.pathname);
  const bucket = match?.[1] ? decodeURIComponent(match[1]) : null;
  if (!match || !bucket || !names.includes(bucket)) return new Response("unknown bucket", { status: 404 });
  try {
    if (match[2] === "list") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 200) || 200));
      return Response.json(await source.list(bucket, prefix, url.searchParams.get("after"), limit));
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
