import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, sep } from "node:path";

const cache = new Map<string, string | null>();

export function repositoryFor(directory: string | null): string | null {
  if (!directory) return null;
  if (cache.has(directory)) return cache.get(directory) ?? null;
  let result: string | null = null;
  try {
    let candidate = directory;
    if (!existsSync(candidate)) {
      const marker = `${sep}.claude${sep}worktrees${sep}`;
      const index = candidate.indexOf(marker);
      if (index < 0) return null;
      candidate = candidate.slice(0, index);
    }
    const common = execFileSync("git", ["-C", candidate, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000,
    }).trim();
    result = basename(common) === ".git" ? basename(dirname(common)) : basename(common).replace(/\.git$/, "");
  } catch {
    // Sessions can belong to deleted directories or outside a Git repository.
  }
  cache.set(directory, result);
  return result;
}
