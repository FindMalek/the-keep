import { readFileSync } from "node:fs";
import type { JournalStats } from "../shared/types";

const PATH = `${process.env.DATA_DIR ?? "/data"}/journal.json`;

export function journal(): JournalStats {
  try {
    const data = JSON.parse(readFileSync(PATH, "utf8")) as Partial<JournalStats>;
    return { at: data.at ?? null, diskBytes: data.diskBytes ?? null, capBytes: data.capBytes ?? null, hours: data.hours ?? [], top: data.top ?? [] };
  } catch {
    return { at: null, diskBytes: null, capBytes: null, hours: [], top: [] };
  }
}
