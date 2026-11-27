import { useEffect, useState } from "react";

export type Theme = "system" | "light" | "dark";
const KEY = "keep:theme";

function stored(): Theme {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(theme: Theme = stored()): void {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

/** system → light → dark, remembered per browser. */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(stored);
  useEffect(() => applyTheme(theme), [theme]);
  const cycle = () => {
    const next: Theme = theme === "system" ? "light" : theme === "light" ? "dark" : "system";
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // Remembering is a convenience only.
    }
    setTheme(next);
  };
  return [theme, cycle];
}
