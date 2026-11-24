import { useEffect, useState } from "react";
import type { SessionRow, UsageRow } from "../../sessions/store";
import type { ParsedSession } from "../../sessions/types";

export interface SessionsPayload {
  sessions: SessionRow[];
  usage: UsageRow[];
  total: number;
  repositories: string[];
}

const REFRESH_MS = 30_000;

export function useSessions(repository: string | null, offset: number): SessionsPayload | null {
  const [data, setData] = useState<SessionsPayload | null>(null);
  useEffect(() => {
    let cancelled = false;
    setData(null);
    const load = async (): Promise<void> => {
      try {
        const params = new URLSearchParams({ offset: String(offset) });
        if (repository !== null) params.set("repository", repository);
        const response = await fetch(`/api/sessions?${params}`);
        if (response.ok && !cancelled) setData((await response.json()) as SessionsPayload);
      } catch {
        // keep the last good data
      }
    };
    void load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [repository, offset]);
  return data;
}

export function useSession(id: string | null): ParsedSession | null {
  const [data, setData] = useState<ParsedSession | null>(null);
  useEffect(() => {
    setData(null);
    if (!id) return;
    let cancelled = false;
    fetch(`/api/session?id=${encodeURIComponent(id)}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((json) => {
        if (!cancelled) setData(json as ParsedSession | null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id]);
  return data;
}
