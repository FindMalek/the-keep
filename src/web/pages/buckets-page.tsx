import { useEffect, useState } from "react";
import type { BucketDeleteResult, BucketListing, BucketObject, GarageStats, PrefixTotal } from "../../shared/types";
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

function useListing(bucket: string | null, prefix: string, version: number) {
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
  }, [bucket, prefix, version]);

  async function more(): Promise<void> {
    if (!bucket || !listing?.next) return;
    setLoadingMore(true);
    const response = await fetch(`/api/buckets/${encodeURIComponent(bucket)}/list?prefix=${encodeURIComponent(prefix)}&after=${encodeURIComponent(listing.next)}`).catch(() => null);
    if (response?.ok) {
      const page = (await response.json()) as BucketListing;
      setListing({ ...listing, objects: [...listing.objects, ...page.objects], next: page.next });
    }
    setLoadingMore(false);
  }

  return { listing, error, more, loadingMore };
}


const totalUrl = (bucket: string, prefix: string) => `/api/buckets/${encodeURIComponent(bucket)}/total?prefix=${encodeURIComponent(prefix)}`;

/** Objects and bytes under a prefix, counted server-side; null while counting. */
function usePrefixTotal(bucket: string | null, prefix: string | null, version: number): PrefixTotal | null | "failed" {
  const [total, setTotal] = useState<PrefixTotal | null | "failed">(null);
  useEffect(() => {
    setTotal(null);
    if (!bucket || prefix === null) return;
    let current = true;
    fetch(totalUrl(bucket, prefix))
      .then(async (response) => current && setTotal(response.ok ? ((await response.json()) as PrefixTotal) : "failed"))
      .catch(() => current && setTotal("failed"));
    return () => {
      current = false;
    };
  }, [bucket, prefix, version]);
  return total;
}

const countLabel = (total: PrefixTotal) => `${total.capped ? "over " : ""}${total.objects.toLocaleString()} objects · ${bytes(total.bytes)}`;

/** Same rule as the server: one folder needs its name, several items need the bucket's, one object needs nothing. */
function confirmationFor(bucket: string, keys: string[], prefixes: string[]): string | null {
  if (prefixes.length === 1 && keys.length === 0) return nameOf(prefixes[0]!);
  if (prefixes.length + keys.length > 1) return bucket;
  return null;
}

interface Doomed {
  keys: BucketObject[];
  prefixes: string[];
}

/** In-page confirmation: says exactly what goes, asks for the name when it's more than one object. */
function DeleteConfirm({ bucket, doomed, onCancel, onDone }: { bucket: string; doomed: Doomed; onCancel: () => void; onDone: (result: BucketDeleteResult) => void }) {
  const [typed, setTyped] = useState("");
  const [state, setState] = useState<"idle" | "deleting" | string>("idle");
  const [folders, setFolders] = useState<PrefixTotal | null>(doomed.prefixes.length ? null : { objects: 0, bytes: 0, capped: false });
  const keys = doomed.keys.map((object) => object.key);
  const required = confirmationFor(bucket, keys, doomed.prefixes);

  useEffect(() => {
    if (!doomed.prefixes.length) return;
    let current = true;
    Promise.all(doomed.prefixes.map((prefix) => fetch(totalUrl(bucket, prefix)).then((response) => response.json() as Promise<PrefixTotal>)))
      .then((all) => current && setFolders(all.reduce((sum, t) => ({ objects: sum.objects + t.objects, bytes: sum.bytes + t.bytes, capped: sum.capped || t.capped }), { objects: 0, bytes: 0, capped: false })))
      .catch(() => current && setState("could not count the folder"));
    return () => {
      current = false;
    };
  }, [bucket, doomed]);

  const total = folders && { objects: folders.objects + doomed.keys.length, bytes: folders.bytes + doomed.keys.reduce((sum, object) => sum + object.size, 0), capped: folders.capped };
  const what =
    doomed.prefixes.length === 1 && !doomed.keys.length
      ? `folder ${doomed.prefixes[0]}`
      : doomed.keys.length === 1 && !doomed.prefixes.length
        ? nameOf(keys[0]!)
        : [doomed.prefixes.length ? `${doomed.prefixes.length} folder${doomed.prefixes.length > 1 ? "s" : ""}` : "", doomed.keys.length ? `${doomed.keys.length} file${doomed.keys.length > 1 ? "s" : ""}` : ""].filter(Boolean).join(" and ");
  const ready = !!total && (required === null || typed.trim() === required) && state !== "deleting";

  async function submit(): Promise<void> {
    setState("deleting");
    const response = await fetch(`/api/buckets/${encodeURIComponent(bucket)}/delete`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-keep-action": "1" },
      body: JSON.stringify({ keys, prefixes: doomed.prefixes, confirm: typed.trim() }),
    }).catch(() => null);
    if (!response) return setState("could not reach the server");
    if (!response.ok) return setState(await response.text());
    onDone((await response.json()) as BucketDeleteResult);
  }

  return (
    <form
      className="confirm"
      role="alertdialog"
      aria-label={`delete ${what}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) void submit();
      }}
    >
      <p className="confirm-what">
        delete <strong className="mono">{what}</strong> from <span className="mono">{bucket}</span>
      </p>
      <p className="confirm-count mono">{total ? `${countLabel(total)} go for good. there is no undo.` : "counting what's in it…"}</p>
      {required !== null && (
        <label className="confirm-type">
          <span className="small muted">
            type <strong className="mono confirm-name">{required}</strong> to confirm
          </span>
          <input className="input mono" value={typed} onChange={(event) => setTyped(event.target.value)} autoFocus spellCheck={false} autoComplete="off" aria-label={`type ${required} to confirm`} />
        </label>
      )}
      {state !== "idle" && state !== "deleting" && <p className="small level-crit">{state}</p>}
      <div className="confirm-actions">
        <button type="submit" className={`button${ready ? " button-armed" : ""}`} disabled={!ready} autoFocus={required === null}>
          {state === "deleting" ? "deleting…" : total ? `delete ${total.objects.toLocaleString()} object${total.objects === 1 ? "" : "s"}` : "delete"}
        </button>
        <button type="button" className="button button-quiet" onClick={onCancel}>
          cancel
        </button>
      </div>
    </form>
  );
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

/** Browsing of Garage buckets through a read-only key; deletes, where allowed, go through a separate write key. */
export function BucketsPage({ garage }: { garage: GarageStats }) {
  const search = useSearch();
  const phone = useMedia(PHONE);
  const bucket = search.get("b") ?? garage.buckets[0]?.name ?? null;
  const prefix = search.get("p") ?? "";
  const picked = search.get("k");
  const [version, setVersion] = useState(0);
  const { listing, error, more, loadingMore } = useListing(bucket, prefix, version);
  // At the bucket's root Garage's own numbers are exact and instant; inside a folder they are counted.
  const total = usePrefixTotal(bucket, prefix ? prefix : null, version);
  const object = picked ? (listing?.objects.find((candidate) => candidate.key === picked) ?? null) : null;
  const crumbs = prefix.split("/").filter(Boolean);
  const info = garage.buckets.find((candidate) => candidate.name === bucket);
  const [selected, setSelected] = useState<Map<string, BucketObject | null>>(new Map());
  const [doomed, setDoomed] = useState<Doomed | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const deletable = listing?.deletable === true;

  useEffect(() => {
    setSelected(new Map());
    setDoomed(null);
    setDone(null);
  }, [bucket, prefix]);

  const open = (patch: Record<string, string | null>) => setQuery({ k: null, ...patch });
  const toggle = (name: string, value: BucketObject | null) =>
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(name)) next.delete(name);
      else next.set(name, value);
      return next;
    });
  const ask = (target: Doomed) => {
    setDone(null);
    setDoomed(target);
  };
  const selection: Doomed = {
    keys: [...selected.values()].filter((value): value is BucketObject => value !== null),
    prefixes: [...selected].filter(([, value]) => value === null).map(([name]) => name),
  };
  const selectedBytes = selection.keys.reduce((sum, entry) => sum + entry.size, 0);

  const meta = !info
    ? undefined
    : !prefix
      ? `${info.objects.toLocaleString()} objects · ${bytes(info.bytes)}${info.quotaBytes ? ` of ${bytes(info.quotaBytes)}` : ""}`
      : total === null
        ? "counting…"
        : total === "failed"
          ? "could not count"
          : `${countLabel(total)}${info.bytes ? ` · ${Math.round((total.bytes / info.bytes) * 100)}% of the bucket` : ""}`;

  return (
    <>
      <PageHeader title="buckets" meta={`garage · ${garage.buckets.length} buckets · deletes only where allowed`} />
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
          meta={meta}
          flush
        >
          {listing && !deletable && (
            <p className="bucket-lock small">
              <span className="bucket-lock-tag">locked</span>
              <span className="muted">read only · {listing.locked ?? "deletes are off"}</span>
            </p>
          )}
          {deletable && selected.size > 0 && !doomed && (
            <div className="selection-bar">
              <span className="mono small">
                {selected.size} selected{selection.keys.length ? ` · ${bytes(selectedBytes)}` : ""}
                {selection.prefixes.length ? ` · ${selection.prefixes.length} folder${selection.prefixes.length > 1 ? "s" : ""} counted on delete` : ""}
              </span>
              <button type="button" className="button button-danger" onClick={() => ask(selection)}>
                delete selected…
              </button>
              <button type="button" className="button button-quiet" onClick={() => setSelected(new Map())}>
                clear
              </button>
            </div>
          )}
          {doomed && bucket && (
            <DeleteConfirm
              bucket={bucket}
              doomed={doomed}
              onCancel={() => setDoomed(null)}
              onDone={(result) => {
                setDoomed(null);
                setSelected(new Map());
                setDone(`deleted ${result.deleted.toLocaleString()} objects${result.bytes ? ` · ${bytes(result.bytes)}` : ""}${result.failed.length ? ` · ${result.failed.length} failed` : ""}`);
                setQuery({ k: null });
                setVersion((current) => current + 1);
              }}
            />
          )}
          {done && <p className="selection-bar small mono">{done}</p>}
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
            <ul className={`objects${deletable ? " is-editable" : ""}`}>
              {prefix && (
                <li className="object-row">
                  {deletable && <span className="object-check" />}
                  <button type="button" className="object" onClick={() => open({ p: crumbs.length > 1 ? `${crumbs.slice(0, -1).join("/")}/` : null })}>
                    <span className="object-thumb object-glyph" aria-hidden="true">
                      ↑
                    </span>
                    <span className="muted">up one folder</span>
                  </button>
                  {deletable && <span className="object-delete" />}
                </li>
              )}
              {listing.prefixes.map((folder) => (
                <li key={folder} className="object-row">
                  {deletable && (
                    <label className="object-check">
                      <input type="checkbox" checked={selected.has(folder)} onChange={() => toggle(folder, null)} aria-label={`select folder ${nameOf(folder)}`} />
                    </label>
                  )}
                  <button type="button" className="object" onClick={() => open({ p: folder })}>
                    <span className="object-thumb folder" aria-hidden="true" />
                    <span className="ellipsis">{nameOf(folder)}/</span>
                  </button>
                  {deletable && (
                    <button type="button" className="object-delete" onClick={() => ask({ keys: [], prefixes: [folder] })} aria-label={`delete folder ${nameOf(folder)}`}>
                      delete
                    </button>
                  )}
                </li>
              ))}
              {listing.objects.map((entry) => (
                <li key={entry.key} className="object-row">
                  {deletable && (
                    <label className="object-check">
                      <input type="checkbox" checked={selected.has(entry.key)} onChange={() => toggle(entry.key, entry)} aria-label={`select ${nameOf(entry.key)}`} />
                    </label>
                  )}
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
                  {deletable && (
                    <button type="button" className="object-delete" onClick={() => ask({ keys: [entry], prefixes: [] })} aria-label={`delete ${nameOf(entry.key)}`}>
                      delete
                    </button>
                  )}
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
