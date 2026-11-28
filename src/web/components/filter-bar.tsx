import { useEffect, useRef, type ReactNode } from "react";

export interface FilterOption {
  value: string;
  label: string;
  count?: number;
  tone?: "crit" | "warn";
}

interface FilterBarProps {
  query: string;
  onQuery: (value: string) => void;
  placeholder: string;
  options?: FilterOption[];
  value?: string;
  onChange?: (value: string) => void;
  /** Selects and toggles on the right. */
  children?: ReactNode;
  className?: string;
}

/** Search (`/` focuses, Esc clears), one row of filter chips with counts, then extra controls. */
export function FilterBar({ query, onQuery, placeholder, options, value, onChange, children, className }: FilterBarProps) {
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key !== "/" || target?.closest("input, textarea, select")) return;
      event.preventDefault();
      input.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className={`filter-bar${className ? ` ${className}` : ""}`}>
      <label className="search">
        <span className="sr-only">{placeholder}</span>
        <input
          ref={input}
          type="search"
          value={query}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              onQuery("");
              input.current?.blur();
            }
          }}
        />
        <kbd aria-hidden="true">/</kbd>
      </label>
      {options && (
        <div className="filter-chips" role="radiogroup" aria-label="filter">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={option.value === value}
              className={`filter-chip${option.tone ? ` is-${option.tone}` : ""}`}
              onClick={() => onChange?.(option.value)}
            >
              {option.label}
              {option.count !== undefined && <span className="filter-count">{option.count}</span>}
            </button>
          ))}
        </div>
      )}
      {children && <div className="filter-extra">{children}</div>}
    </div>
  );
}

interface SelectProps {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}

/** A native select styled as a chip, so phones keep their own picker. */
export function Select({ label, value, options, onChange }: SelectProps) {
  return (
    <label className="select">
      <span className="select-label">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
