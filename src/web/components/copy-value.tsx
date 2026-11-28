import { useEffect, useRef, useState, type ReactNode } from "react";

interface CopyValueProps {
  label?: ReactNode;
  value: string | null;
  /** Shown instead of the value (e.g. a shortened id); the full value is what gets copied. */
  display?: ReactNode;
  /** Fetches the text to copy on click (e.g. a markdown export). */
  load?: () => Promise<string>;
  className?: string;
}

/** `label value ⧉`: copies on click and says so for a moment. */
export function CopyValue({ label, value, display, load, className }: CopyValueProps) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const text = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (state === "idle") return;
    const id = setTimeout(() => setState("idle"), 1200);
    return () => clearTimeout(id);
  }, [state]);

  if (value === null && !load) {
    return (
      <span className={`copy is-empty${className ? ` ${className}` : ""}`}>
        {label !== undefined && <span className="copy-label">{label}</span>}
        <span className="copy-value">—</span>
      </span>
    );
  }

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(load ? await load() : (value ?? ""));
      setState("copied");
    } catch {
      setState("failed");
      const node = text.current;
      if (node) window.getSelection()?.selectAllChildren(node);
    }
  }

  return (
    <button type="button" className={`copy${className ? ` ${className}` : ""}`} onClick={copy} title={value ? `copy ${value}` : "copy"}>
      {label !== undefined && <span className="copy-label">{label}</span>}
      <span className="copy-value" ref={text}>
        {state === "copied" ? "copied" : state === "failed" ? "select" : (display ?? value)}
      </span>
      <span className="copy-glyph" aria-hidden="true">
        {state === "copied" ? "✓" : "⧉"}
      </span>
      <span className="sr-only" aria-live="polite">
        {state === "copied" ? "copied" : ""}
      </span>
    </button>
  );
}
