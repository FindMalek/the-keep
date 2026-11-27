import type { ReactNode } from "react";

export function Chip({ tone = "plain", children, title }: { tone?: "plain" | "warn" | "crit" | "solid"; children: ReactNode; title?: string }) {
  return (
    <span className={`chip chip-${tone}`} title={title}>
      {children}
    </span>
  );
}
