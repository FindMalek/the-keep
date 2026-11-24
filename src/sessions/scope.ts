import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

export function createSessionScope(includes: string[], excludes: string[]): (directory: string | null) => boolean {
  const roots = includes.map((path) => {
    try { return realpathSync(path); } catch { return null; }
  }).filter((path): path is string => path !== null);

  return (directory) => {
    if (!directory) return includes.length === 0;
    try {
      const path = realpathSync(directory);
      if (excludes.some((excluded) => directory.includes(excluded) || path.includes(excluded))) return false;
      if (includes.length === 0) return true;
      return roots.some((root) => {
        const rest = relative(root, path);
        return rest === "" || (!isAbsolute(rest) && rest !== ".." && !rest.startsWith(`..${sep}`));
      });
    } catch {
      return includes.length === 0 && !excludes.some((excluded) => directory.includes(excluded));
    }
  };
}
