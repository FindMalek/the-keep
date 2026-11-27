import { useEffect, useState } from "react";
import type { BucketListing, BucketObject, GarageStats } from "../../shared/types";
import { Select } from "../components/filter-bar";
import { Meter } from "../components/meter";
import { PageHeader } from "../components/page-header";
import { Empty, Panel } from "../components/panel";
import { bytes } from "../lib/format";
import { QUOTA } from "../lib/level";
import { setQuery, useSearch } from "../lib/router";
import { since } from "../lib/time";
import { PHONE, useMedia } from "../lib/use-media";

const IMAGE = /\.(jpe?g|png|webp|gif|avif)$/i;
const AUDIO = /\.(mp3|m4a|flac|ogg|opus|wav)$/i;
const VIDEO = /\.(mp4|webm|mov)$/i;
const PDF = /\.pdf$/i;
const TEXT = /\.(txt|md|json|ya?ml|toml|csv|log|ini|conf|sh|ts|js|py|html|xml|sql)$/i;
const PREVIEW_LIMIT = 25 * 1024 * 1024;
const TEXT_LIMIT = 64 * 1024;

const objectUrl = (bucket: string, key: string, download = false) => `/api/buckets/${encodeURIComponent(bucket)}/object?key=${encodeURIComponent(key)}${download ? "&download=1" : ""}`;
const nameOf = (key: string) => key.split("/").filter(Boolean).at(-1) ?? key;

function useListing(bucket: string | null, prefix: string) {
  const [listing, setListing] = useState<BucketListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    setListing(null);
    setError(null);
    if (!bucket) return;
    let current = true;
    fetch(`/api/buckets/${encodeURIComponent(bucket)}/list?prefix=${encodeURIComponent(prefix)}`)
      .then(async (response) => {
        if (!current) return;
        if (response.ok) setListing((await response.json()) as BucketListing);
        else setError(await response.text());
      })
      .catch(() => current && setError("could not reach the server"));
    return () => {
      current = false;
    };
  }, [bucket, prefix]);

  async function more(): Promise<void> {
    if (!bucket || !listing?.next) return;
    setLoadingMore(true);
    const response = await fetch(`/api/buckets/${encodeURIComponent(bucket)}/list?prefix=${encodeURIComponent(prefix)}&after=${encodeURIComponent(listing.next)}`).catch(() => null);
    if (response?.ok) {
      const page = (await response.json()) as BucketListing;
      setListing({ prefixes: listing.prefixes, objects: [...listing.objects, ...page.objects], next: page.next });
    }
    setLoadingMore(false);
  }

  return { listing, error, more, loadingMore };
}

function TextPreview({ url }: { url: string }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    fetch(url, { headers: { range: `bytes=0-${TEXT_LIMIT - 1}` } })
      .then((response) => response.text())
      .then((body) => current && setText(body.slice(0, TEXT_LIMIT)))
      .catch(() => current && setText("could not load"));
    return () => {
      current = false;
    };
  }, [url]);
  return <pre className="preview-text">{text ?? "loading…"}</pre>;
}

function Preview({ bucket, object, onClose }: { bucket: string; object: BucketObject; onClose: () => void }) {
  const url = objectUrl(bucket, object.key);
  const big = object.size > PREVIEW_LIMIT && !AUDIO.test(object.key) && !VIDEO.test(object.key);
  let body;
  if (big) body = <Empty>too large to preview here · {bytes(object.size)}</Empty>;
  else if (IMAGE.test(object.key)) body = <img className="preview-media" src={url} alt={nameOf(object.key)} />;
  else if (AUDIO.test(object.key)) body = <audio className="preview-audio" src={url} controls />;
  else if (VIDEO.test(object.key)) body = <video className="preview-media" src={url} controls />;
  // No sandbox attribute: Chrome's PDF viewer won't run inside one. The response carries its own CSP instead.
  else if (PDF.test(object.key)) body = <iframe className="preview-pdf" src={url} title={nameOf(object.key)} />;
  else if (TEXT.test(object.key)) body = <TextPreview url={url} />;
  else body = <Empty>binary · {bytes(object.size)} · no preview (some apps store encrypted blobs)</Empty>;
  return (
    <div className="preview" role="dialog" aria-label={`preview ${nameOf(object.key)}`}>
      <div className="preview-bar">
        <span className="ellipsis mono">{nameOf(object.key)}</span>
        <span className="muted small">
          {bytes(object.size)} · {since(object.modified)}
        </span>
        <a className="button" href={objectUrl(bucket, object.key, true)}>
          download
        </a>
        <button type="button" className="button button-quiet" onClick={onClose}>
          close
        </button>
      </div>
      <div className="preview-body">{body}</div>
    </div>
  );
}

/** Read-only browsing of Garage buckets through a key that can only list and read. */
export function BucketsPage({ garage }: { garage: GarageStats }) {
  const search = useSearch();
  const phone = useMedia(PHONE);
  const bucket = search.get("b") ?? garage.buckets[0]?.name ?? null;
  const prefix = search.get("p") ?? "";
  const picked = search.get("k");
  const { listing, error, more, loadingMore } = useListing(bucket, prefix);
  const object = picked ? (listing?.objects.find((candidate) => candidate.key === picked) ?? null) : null;
  const crumbs = prefix.split("/").filter(Boolean);
  const info = garage.buckets.find((candidate) => candidate.name === bucket);

  const open = (patch: Record<string, string | null>) => setQuery({ k: null, ...patch });

  return (
    <>
      <PageHeader title="buckets" meta={`garage · ${garage.buckets.length} buckets · read only`} />
      <div className="grid">
        {phone ? (
          <div className="grid-full">
            <Select label="bucket" value={bucket ?? ""} onChange={(name) => open({ b: name, p: null })} options={garage.buckets.map((entry) => ({ value: entry.name, label: entry.name }))} />
          </div>
        ) : (
          <Panel title="buckets" span={3} meta={garage.healthy === false ? "unreachable" : "healthy"} flush>
            <ul className="bucket-list">
              {garage.buckets.map((entry) => (
                <li key={entry.name}>
                  <button type="button" className="bucket" aria-current={entry.name === bucket ? "true" : undefined} onClick={() => open({ b: entry.name, p: null })}>
                    <span className="bucket-name ellipsis">{entry.name}</span>
                    <span className="muted small">
                      {bytes(entry.bytes)}
                      {entry.quotaBytes ? ` of ${bytes(entry.quotaBytes)}` : ""} · {entry.objects.toLocaleString()} objects
                    </span>
                    <Meter value={entry.quotaBytes ? entry.bytes / entry.quotaBytes : 0} thresholds={QUOTA} label={`${entry.name} quota used`} />
                  </button>
                </li>
              ))}
            </ul>
          </Panel>
        )}
        <Panel
          span={9}
          title={
            <span className="crumbs">
              <button type="button" onClick={() => open({ p: null })}>
                {bucket ?? "—"}
              </button>
              {crumbs.map((crumb, index) => (
                <span key={index}>
                  <span className="muted"> / </span>
                  <button type="button" onClick={() => open({ p: `${crumbs.slice(0, index + 1).join("/")}/` })}>
                    {crumb}
                  </button>
                </span>
              ))}
            </span>
          }
          meta={info ? `${info.objects.toLocaleString()} objects · ${bytes(info.bytes)}` : undefined}
          flush
        >
          {object && bucket && <Preview bucket={bucket} object={object} onClose={() => setQuery({ k: null })} />}
          {error ? (
            <div className="box-pad">
              <Empty>
                <span className="level-warn">{error}</span>
              </Empty>
            </div>
          ) : !listing ? (
            <div className="box-pad">
              <Empty>listing…</Empty>
            </div>
          ) : listing.prefixes.length + listing.objects.length === 0 ? (
            <div className="box-pad">
              <Empty>empty</Empty>
            </div>
          ) : (
            <ul className="objects">
              {prefix && (
                <li>
                  <button type="button" className="object" onClick={() => open({ p: crumbs.length > 1 ? `${crumbs.slice(0, -1).join("/")}/` : null })}>
                    <span className="object-thumb object-glyph" aria-hidden="true">
                      ↑
                    </span>
                    <span className="muted">up one folder</span>
                  </button>
                </li>
              )}
              {listing.prefixes.map((folder) => (
                <li key={folder}>
                  <button type="button" className="object" onClick={() => open({ p: folder })}>
                    <span className="object-thumb folder" aria-hidden="true" />
                    <span className="ellipsis">{nameOf(folder)}/</span>
                  </button>
                </li>
              ))}
              {listing.objects.map((entry) => (
                <li key={entry.key}>
                  <button type="button" className="object" aria-current={entry.key === picked ? "true" : undefined} onClick={() => setQuery({ k: entry.key })}>
                    {IMAGE.test(entry.key) && entry.size < PREVIEW_LIMIT && bucket ? (
                      <img className="object-thumb" src={objectUrl(bucket, entry.key)} alt="" loading="lazy" />
                    ) : (
                      <span className="object-thumb file" aria-hidden="true" />
                    )}
                    <span className="ellipsis">{nameOf(entry.key)}</span>
                    <span className="n-bytes muted">{bytes(entry.size)}</span>
                    <span className="object-when muted">{entry.modified ? since(entry.modified) : ""}</span>
                  </button>
                </li>
              ))}
              {listing.next && (
                <li>
                  <button type="button" className="object object-more" onClick={() => void more()} disabled={loadingMore}>
                    {loadingMore ? "loading…" : "load more"}
                  </button>
                </li>
              )}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}
