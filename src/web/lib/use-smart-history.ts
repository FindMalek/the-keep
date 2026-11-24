import { useEffect, useState } from "react";
import type { SmartHistoryRow } from "../../shared/types";

const REFRESH_MS = 5 * 60_000;

/** Every recorded daily SMART run, oldest first. Empty until the first run is recorded. */
export function useSmartHistory(): SmartHistoryRow[] {
  const [rows, setRows] = useState<SmartHistoryRow[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const response = await fetch("/api/smart-history");
        if (response.ok && !cancelled) setRows((await response.json()) as SmartHistoryRow[]);
      } catch {
        // keep what we have
      }
    };
    void load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);
  return rows;
}
