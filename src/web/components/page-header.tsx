import type { KeyboardEvent, ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  meta?: ReactNode;
  children?: ReactNode;
}

/** Sticky under the title bar: page title, a one-line summary, then controls on the right. */
export function PageHeader({ title, meta, children }: PageHeaderProps) {
  return (
    <div className="page-header">
      <div className="page-title">
        <h1>{title}</h1>
        {meta !== undefined && <span className="page-meta">{meta}</span>}
      </div>
      {children && <div className="page-controls">{children}</div>}
    </div>
  );
}

interface TabsProps<T extends string> {
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  /** Text per option when it differs from the value. */
  labels?: Partial<Record<T, ReactNode>>;
}

/** Segmented control; arrow keys move between options. */
export function Tabs<T extends string>({ options, value, onChange, label, labels }: TabsProps<T>) {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const index = options.indexOf(value) + (event.key === "ArrowRight" ? 1 : -1);
    const next = options[(index + options.length) % options.length];
    if (next !== undefined) {
      onChange(next);
      (event.currentTarget.querySelector(`[data-value="${next}"]`) as HTMLElement | null)?.focus();
    }
  }
  return (
    <div className="tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {options.map((option) => (
        <button
          key={option}
          type="button"
          role="tab"
          data-value={option}
          className="tab"
          aria-selected={option === value}
          tabIndex={option === value ? 0 : -1}
          onClick={() => onChange(option)}
        >
          {labels?.[option] ?? option}
        </button>
      ))}
    </div>
  );
}
