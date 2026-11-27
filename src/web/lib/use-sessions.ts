import { useCallback, useEffect, useRef, useState } from "react";
import type { ModelPrice, SessionFacets, SessionListRow, SessionsPayload, UsageDay } from "../../shared/types";
import type { ParsedSession } from "../../sessions/types";

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

export type SessionDetail = ParsedSession & { costs: (number | null)[] };

export function useSession(id: string | null): SessionDetail | null | "missing" {
  const [data, setData] = useState<SessionDetail | null | "missing">(null);
  useEffect(() => {
    setData(null);
    if (!id) return;
    let cancelled = false;
    fetch(`/api/session?id=${encodeURIComponent(id)}`)
      .then((response) => (response.ok ? response.json() : "missing"))
      .then((json) => !cancelled && setData(json as SessionDetail | "missing"))
      .catch(() => !cancelled && setData("missing"));
    return () => {
      cancelled = true;
    };
  }, [id]);
  return data;
}
