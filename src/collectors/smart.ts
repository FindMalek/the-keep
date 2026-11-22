import { readFileSync } from "node:fs";
import type { SmartStats } from "../shared/types";

const PATH = `${process.env.DATA_DIR ?? "/data"}/smart.json`;

export function smart(): SmartStats {
  try {
    const data = JSON.parse(readFileSync(PATH, "utf8")) as SmartStats;
    return { at: data.at ?? null, disks: data.disks ?? [] };
  } catch {
    return { at: null, disks: [] };
  }
}
