/**
 * The repo a session ran in, not its worktree: `…/jobflow/.claude/worktrees/jfd-10371-d76db3` → `jobflow`,
 * `…/Projects/jobflow-JFD-10371` → `jobflow`.
 */
export function projectOf(directory: string | null): string {
  if (!directory) return "—";
  const parts = directory.split("/").filter(Boolean);
  const tree = parts.findIndex((part) => part === "worktrees" || part === ".worktrees");
  const base = tree > 0 ? (parts[parts[tree - 1] === ".claude" ? tree - 2 : tree - 1] ?? "") : (parts.at(-1) ?? "");
  return base.replace(/-[A-Za-z]+-\d+.*$/, "") || base;
}
