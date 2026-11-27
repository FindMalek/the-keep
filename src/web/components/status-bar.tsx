import type { HostInfo } from "../../shared/types";
import { useTheme, type Theme } from "../lib/theme";
import { CopyValue } from "./copy-value";

const THEME_GLYPH: Record<Theme, string> = { system: "◐", light: "○", dark: "●" };

export function ThemeToggle() {
  const [theme, cycle] = useTheme();
  return (
    <button type="button" className="theme-toggle" onClick={cycle} title="theme: system, light, dark">
      <span aria-hidden="true">{THEME_GLYPH[theme]}</span> theme {theme}
    </button>
  );
}

export function StatusBar({ host }: { host: HostInfo | null }) {
  return (
    <footer className="status-bar">
      <div className="status-left">
        <CopyValue label="lan" value={host?.lanIp ?? null} />
        <CopyValue label="tailscale" value={host?.tailscaleIp ?? null} />
        <CopyValue label="public" value={host?.publicIp ?? null} />
      </div>
      <div className="status-right">
        <ThemeToggle />
      </div>
    </footer>
  );
}
