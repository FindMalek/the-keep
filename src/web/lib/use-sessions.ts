import { useEffect, useState } from "react";
import type { SessionRow, UsageRow } from "../../sessions/store";
import type { ParsedSession } from "../../sessions/types";

export interface SessionsPayload {
  sessions: SessionRow[];
  usage: UsageRow[];
}

const REFRESH_MS = 30_000;

export function useSessions(): SessionsPayload | null {
  const [data, setData] = useState<SessionsPayload | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const response = await fetch("/api/sessions");
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
  }, []);
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
