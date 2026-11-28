import { useCallback, useEffect, useRef, useState } from "react";
import type { ModelPrice, SessionFacets, SessionListRow, SessionsPayload, UsageDay } from "../../shared/types";
import type { SessionMessage, SessionPage } from "../../sessions/types";

const REFRESH_MS = 60_000;
const PAGE = 50;

export interface SessionQuery {
  tool: string;
  machine: string;
  project: string;
  model: string;
  q: string;
  from: number | null;
  to: number | null;
}

function url(query: SessionQuery, offset: number): string {
  const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset), tz: String(new Date().getTimezoneOffset()) });
  for (const key of ["tool", "machine", "project", "model", "q"] as const) if (query[key]) params.set(key, query[key]);
  if (query.from) params.set("from", String(query.from));
  if (query.to) params.set("to", String(query.to));
  return `/api/sessions?${params}`;
}

/** The filtered list, 50 at a time, plus 90 days of usage (unfiltered) from the first page. */
export function useSessionList(query: SessionQuery) {
  const [rows, setRows] = useState<SessionListRow[]>([]);
  const [total, setTotal] = useState(0);
  const [usage, setUsage] = useState<UsageDay[] | null>(null);
  const [pricesUpdatedAt, setPricesUpdatedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const key = url(query, 0);
  const generation = useRef(0);

  const fetchPage = useCallback(
    async (offset: number) => {
      const mine = generation.current;
      setLoading(true);
      try {
        const response = await fetch(url(query, offset));
        if (!response.ok || mine !== generation.current) return;
        const data = (await response.json()) as SessionsPayload;
        setRows((current) => (offset ? [...current, ...data.sessions] : data.sessions));
        setTotal(data.total);
        setPricesUpdatedAt(data.pricesUpdatedAt);
        if (!offset && data.usage.length) setUsage(data.usage);
      } catch {
        // Keep what's shown; the next refresh retries.
      } finally {
        if (mine === generation.current) setLoading(false);
      }
    },
    [key],
  );

  useEffect(() => {
    generation.current += 1;
    void fetchPage(0);
    const id = setInterval(() => void fetchPage(0), REFRESH_MS);
    return () => clearInterval(id);
  }, [fetchPage]);

  const more = useCallback(() => {
    if (!loading && rows.length < total) void fetchPage(rows.length);
  }, [loading, rows.length, total, fetchPage]);

  return { rows, total, usage, pricesUpdatedAt, loading, more };
}

export function useFacets(): SessionFacets | null {
  const [facets, setFacets] = useState<SessionFacets | null>(null);
  useEffect(() => {
    fetch("/api/sessions/facets")
      .then((response) => (response.ok ? response.json() : null))
      .then(setFacets)
      .catch(() => {});
  }, []);
  return facets;
}

export function usePrices(): { updatedAt: number | null; models: { model: string; price: ModelPrice | null }[] } | null {
  const [prices, setPrices] = useState<{ updatedAt: number | null; models: { model: string; price: ModelPrice | null }[] } | null>(null);
  useEffect(() => {
    fetch("/api/prices")
      .then((response) => (response.ok ? response.json() : null))
      .then(setPrices)
      .catch(() => {});
  }, []);
  return prices;
}

const MESSAGE_PAGE = 40;

export interface Transcript {
  /** The first page: session, parent and the whole conversation's summary. */
  head: SessionPage | null | "missing";
  messages: SessionMessage[];
  costs: (number | null)[];
  total: number;
  loading: boolean;
  more: () => void;
  /** Loads pages until `seq` is in, so a jump can scroll to it. */
  through: (seq: number) => Promise<void>;
}

/** A conversation's messages, a page at a time; `more` is called by the scroll sentinel. */
export function useTranscript(id: string | null): Transcript {
  const [head, setHead] = useState<SessionPage | null | "missing">(null);
  const [messages, setMessages] = useState<SessionMessage[]>([]);
  const [costs, setCosts] = useState<(number | null)[]>([]);
  const [loading, setLoading] = useState(false);
  const state = useRef({ id, loaded: 0, total: Infinity, busy: null as Promise<void> | null });

  const fetchNext = useCallback((): Promise<void> => {
    const current = state.current;
    if (current.busy) return current.busy;
    if (!current.id || current.loaded >= current.total) return Promise.resolve();
    const mine = current.id;
    setLoading(true);
    current.busy = fetch(`/api/session?id=${encodeURIComponent(mine)}&offset=${current.loaded}&limit=${MESSAGE_PAGE}`)
      .then(async (response) => {
        if (state.current.id !== mine) return;
        if (!response.ok) {
          if (!current.loaded) setHead("missing");
          current.total = current.loaded;
          return;
        }
        const page = (await response.json()) as SessionPage;
        if (state.current.id !== mine) return;
        if (page.offset === 0) setHead(page);
        current.loaded = page.offset + page.messages.length;
        current.total = page.total;
        setMessages((list) => [...list, ...page.messages]);
        setCosts((list) => [...list, ...page.costs]);
      })
      .catch(() => {
        if (!current.loaded && state.current.id === mine) setHead("missing");
      })
      .finally(() => {
        current.busy = null;
        if (state.current.id === mine) setLoading(false);
      });
    return current.busy;
  }, []);

  useEffect(() => {
    state.current = { id, loaded: 0, total: Infinity, busy: null };
    setHead(null);
    setMessages([]);
    setCosts([]);
    void fetchNext();
  }, [id, fetchNext]);

  const through = useCallback(
    async (seq: number) => {
      // Messages are numbered 0..n-1, so seq is also the index to reach.
      while (state.current.loaded <= seq && state.current.loaded < state.current.total) await fetchNext();
    },
    [fetchNext],
  );

  const more = useCallback(() => void fetchNext(), [fetchNext]);
  const total = head && head !== "missing" ? head.total : 0;
  return { head, messages, costs, total, loading, more, through };
}
