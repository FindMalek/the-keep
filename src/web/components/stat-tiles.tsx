import { jumpTo } from "../lib/jump";
import { levelOf, type Thresholds } from "../lib/level";
import { go } from "../lib/router";
import { Meter } from "./meter";
import { Sparkline } from "./sparkline";

export interface Tile {
  key: string;
  label: string;
  value: string;
  sub?: string;
  /** 0..1, drives the meter and the orange/red color. */
  ratio?: number;
  thresholds?: Thresholds;
  /** Recent values for a micro chart (drawn instead of a meter). */
  series?: number[];
  seriesMax?: number;
  /** Scale the micro chart to its 95th percentile instead of its peak. */
  robust?: boolean;
  /** Section id to jump to on this page, or a path to open. */
  target: string;
  /** Overrides the color when the value is "bad" by its own rules (e.g. sites down). */
  tone?: "warn" | "crit";
}

/** The headline numbers. Each is a button that jumps to the box explaining it. */
export function StatTiles({ tiles, label = "at a glance" }: { tiles: Tile[]; label?: string }) {
  return (
    <section className="tiles" aria-label={label}>
      {tiles.map((tile) => {
        const level = tile.tone ?? (tile.ratio !== undefined ? levelOf(tile.ratio, tile.thresholds) : "normal");
        const tone = level === "normal" ? "ink" : level;
        return (
          <button
            key={tile.key}
            type="button"
            className="tile"
            onClick={() => (tile.target.startsWith("/") ? go(tile.target) : jumpTo(tile.target))}
          >
            <span className="tile-label">
              {tile.label}
              <span className="tile-jump" aria-hidden="true">
                {tile.target.startsWith("/") ? "→" : "↘"}
              </span>
            </span>
            <span className={`tile-value${tone === "ink" ? "" : ` level-${tone}`}`}>{tile.value}</span>
            <span className="tile-sub">{tile.sub ?? " "}</span>
            <span className="tile-graph">
              {tile.series ? (
                <Sparkline
                  values={tile.series}
                  capacity={Math.max(tile.series.length, 2)}
                  stepSec={1}
                  max={tile.seriesMax}
                  format={String}
                  height={20}
                  label={`${tile.label}, recent`}
                  tone={tone}
                  robust={tile.robust}
                  bare
                />
              ) : tile.ratio !== undefined ? (
                <Meter value={tile.ratio} thresholds={tile.thresholds} label={tile.label} />
              ) : null}
            </span>
          </button>
        );
      })}
    </section>
  );
}
