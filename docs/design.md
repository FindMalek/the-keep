# keep dashboard: design system and redesign spec

Status: implemented on branch `dashboard-redesign` (uncommitted), see §6.1 for where the build differs from this spec and the end for server changes. Written 2026-11-27 against commit `c66a1b1`.

**Evidence and its limits.** The live site could not be opened: the Chrome extension refused every call
(account mismatch), and plain curl can't reach the tailnet. So the critique below comes from:

- the code on this branch (every page, panel, `styles.css`, `types.ts`, collectors, `server.ts`);
- the six screenshots in `docs/*.png`, taken 2026-10-11 at 1512×945 CSS px (3024×1890 @2x). They show the old
  `overview` + `system` split, from before `6110a03` merged them into home. Sessions and media weren't there yet;
- the owner's brief (`memory/keep-dashboard-redesign-brief.md`).

Anything marked *(code)* was read from the source, not seen rendered. Anything marked *(shot)* is in the
screenshots. No phone-width rendering was seen; the phone critique is derived from the CSS breakpoints.

---

## 1. Critique

### 1.0 Global failures (every page)

1. **`html { zoom: 1.1 / 1.25 }`** (`styles.css:119-129`) *(code)*. At ≥1400 px the whole page renders at
   1.25×, so every 1 px hairline, 8 px square and 6 px meter lands on fractional device pixels. It's already
   soft today, and it rules out dithering: a 2 px Bayer dot at 1.25× becomes 2.5 px and moirés. It also breaks
   `getBoundingClientRect` and pointer math in Chrome versions before 128. **Remove it.**
2. **Type scale chaos** *(code)*: font sizes in use are 10.5, 11, 11.5, 12, 12.5, 13, 15, 20 and 30 px, nine
   sizes with half-pixel steps. Labels, metas and subheads all differ by 0.5 px, which reads as accident rather
   than hierarchy.
3. **Three greys doing the same job.** `--muted`, `--faint`, `.subhead` (faint), `.empty` (faint) and
   `.panel-header h2::before` (faint) are used interchangeably. In the screenshots *(shot)*, "volumes", "disks",
   "playing now", "recently added" and "most blocked" sit at the same contrast as disabled text. Subheads are
   nearly invisible on dark.
4. **Hairline-grid layout, not boxes.** `.grid { gap: 1px; background: var(--border) }` makes one sheet with
   1 px seams. When a column is shorter, the seam stops and a black hole opens *(shot: memory panel, bottom
   half empty; reading panel, 70% empty; internet panel, 40% empty)*. Nothing is boxed, so nothing has an edge
   to highlight.
5. **Sparklines are stretched vectors.** `sparkline.tsx` draws into a 600-unit viewBox with
   `preserveAspectRatio="none"`. Line weight changes with panel width, and an idle series becomes a flat 1 px
   line glued to the baseline *(shot: memory graph, network tailscale, disk sdb, internet history: all
   flatlines)*. Four of the six graphs on the system screenshot carry no information.
6. **Numbers reflow.** Values are tabular, but their containers are `flex-wrap: wrap` with variable-length
   strings (`.rates`, `.facts`, `.headline`). When `w 4.1 KB/s` becomes `w 112.4 MB/s` the row wraps, the panel
   grows a line, and everything under it shifts. That's the "storage jumps" bug (`styles.css:386`), and memory's
   legend has it too *(shot: "available" wraps under its swatch; swap is clipped to `8.0 G`)*.
7. **Status squares contradict the numbers** *(shot: uptime)*. Rows show a solid white "up" square next to
   `97.43%` in red. The square is *now*, the number is *24 h*, and nothing says so.
8. **"No data" looks like "down".** Uptime bars with no data are dark grey stripes; partial is orange; up is
   light grey *(shot)*. Two thirds of every strip is no-data, and it reads as a wall of failure.
9. **Light theme is a straight inversion**, follows the OS only, and has no toggle.
10. **Links are invisible.** Rows that link (`.row-link`, app names, reading items) look identical to rows that
   don't. Sites, domains, space items and IPs aren't links at all. Only `↗` in a few panel metas hints at
   navigation.
11. **Status bar holds the three IPs**, and they can't be copied. On phone, `status-left > span:nth-child(n+2)`
    hides tailscale and public, so they don't exist on phone at all *(code)*.
12. **Phone nav** *(code)*: 7 icon-only items in 44 px, the current page widened 2.4×, labels hidden. Adding
    a logs page makes 8, and that doesn't fit at 390 px.
13. **Dead CSS**: the base `.grid` template still lists `mus`, `read`, `dnsb`, `inet` areas from the old
    overview. `.level-ok` is used in `smart-panel.tsx` and defined nowhere.

### 1.1 Home (`/`)

Desktop *(code + shot of old overview/system, which home now concatenates)*:

- **CPU and memory appear twice.** Tile `cpu 32%` is followed immediately by a CPU panel whose headline is
  `32%` at 30 px. Memory does the same (`5.6 GiB` tile, then `5.6 GiB` headline). The tiles have no job.
- **The tiles go nowhere.** Only `sites` links (to `/uptime`); the other seven are dead `div`s.
- **Row 2 is unbalanced** (`cpu 6 / mem 3 / net 3`). CPU is ~530 px tall (graph 104 px plus a 6-core list);
  memory is ~200 px of content in a 530 px cell *(shot: the lower 60% of memory is empty)*.
- **Temperatures are a 13-row list of identical meters** *(shot)*: board, dimm 1, dimm 2, package, cores 0-5
  … every bar is 40% and says nothing. Per-core temps aren't next to per-core load, though that pairing is the
  only interesting one.
- **Per-core load** is a 3×2 grid of tiny 6 px meters with the label `core 0` repeated six times.
- **Storage header sums every mount**, backup HDD included (`storage-panel.tsx:15`), so it reports
  `737 GiB / 2.9 TB`: neither usable space nor anything real. Volumes and disk I/O are in one panel, and the
  I/O rows reflow (see 1.0.6). `/srv/backup-hdd` wraps the label column.
- **Disk health** shows `passed` in plain text (`.level-ok` is undefined), plus a 30-bar write chart with no
  axis or scale.
- **Internet** shows one result as a 30 px number plus a 40 px flatline *(shot)*. The 42 tests it already has
  (`internet.history`) aren't listed.
- **Space** is a meter list; the meters are a different width on every row because column 3 is `auto` *(shot:
  bars start at x=590 and x=624)*. Nothing links to its app. Hard vs soft limits are hidden in a `title`
  tooltip ("hover a row for hard or soft"), which doesn't exist on touch.
- **Sites**: the third column is always `—` *(shot)*, because Kuma rows set `status: null`. Sites aren't
  clickable. The DNS row is red because the container resolves through AdGuard's tailnet rewrite (`lookup()`
  in `collectors/system.ts`), a false alarm.
- **System log** panel: a 24-bar SVG stretched to full width (each bar ~50 px wide, no axis), and a top-talkers
  list with no link to the logs themselves.
- **Containers** is a full table of every container, which duplicates `/apps` (per service) and `/uptime`
  (container checks) and sits at the bottom where nobody scrolls. It has no reason to exist in this form.
- **Range tabs** (live/1h/24h/7d/30d) sit in the page header but only affect some panels. The tiles always
  show the last 120 s, which is never labelled.

Phone (≤720 px, from CSS):

- 13 full-width panels in a single column, about 8 screens tall. Tiles are 2-up (4 rows of tiles before any
  content).
- `.cores` goes 2-up with meters ~60 px wide.
- `.volume` drops the meter to a second row, but `.rates` still wraps.
- Tables hide columns via `.hide-narrow`, so the containers table on phone is name/cpu/mem only, and sites lose
  nothing but stay unlinked.

### 1.2 Uptime (`/uptime`)

- 24 h is the only range (issue #102). The 48 half-hour bars are 8 px stripes with 4 px gaps, so the strip looks
  like a barcode *(shot)*.
- **24h and 30d columns show identical values** for every check *(shot)*, because Kuma history is shorter than
  30 days. Two columns are spent repeating one number.
- No-data, up and partial are three greys plus orange, so you can't read them at a glance (1.0.8).
- `response` is one number with no trend, though `kuma:<id>:ms` is stored in history (`server.ts:187`).
- Sites and containers are two identical tables. The container one sits below the fold.
- Phone: the strip column is `hide-narrow`, so **on phone the uptime page has no uptime history at all**. It
  shows name, response and 24h only.

### 1.3 Apps (`/apps`)

- One panel per project, each with a 7-column table repeating its header *(shot: three header rows on one
  screen)*. Column x-positions drift between projects because each table auto-sizes (`containers` at x=1230 /
  1265 / 1255).
- Every app row is `compose · 0% · deployed Xh ago`: low-information repetition.
- No search, no filter, no sort, no pinning (#103). Preview and staging environments are mixed in as subheads.
- The service tooltip (description) only shows on hover.
- Phone: type, domains, cpu and memory are hidden, leaving status, name, containers and last deploy.

### 1.4 Jobs (`/jobs`)

- Nothing explains what a job *is* (a systemd timer on the host, read by keep-agent every N minutes) or why
  some say `dokploy` instead of a button *(shot: `dokploy-docker-cleanup` shows `—  —  dokploy` in grey)*.
- **No logs.** When a job fails, the page says `failed` and nothing else. You have to SSH in.
- The `· 0s` duration on every row is noise.
- `run now` is a full-weight bordered button repeated 7 times, which makes it the loudest thing on the page.
- `ai usage` is on the jobs page (it belongs with sessions). `AiUsagePanel` hand-rolls its own panel markup and
  uses a `down` class that doesn't exist.
- **Recent actions**: `action · detail · time`. It doesn't say who requested it, how long it took, what it
  printed or what it freed (except tidy, which shows that in the server box, not the log).
- Phone: schedule and next run are hidden, so you can't tell when a job runs.

### 1.5 Activity (`/activity`)

- The devices panel (tailnet) has 2 rows and takes 8 of 12 columns at ~500 px tall *(shot: 70% empty)*. The LAN
  devices panel is a separate box with the same columns.
- "connected now" uses a 3-column list whose middle column (browser) wraps to two lines *(shot:
  `Chrome 154 · / macOS`)*.
- The timeline is the only useful part, and it's below the fold. It's a flat 80-row table with chips whose text
  repeats the filter (`deploy` chip under the `deploys` filter). The refs column (deployment ids) is low value at
  full width. There's no search, no per-day density and no count per filter.
- Phone: devices stack first, so the timeline starts about 3 screens down.

### 1.6 Media (`/media`)

- Two half-width panels. Reading shows `0 / 0 / no feeds yet` in ~600 px of height *(shot)*.
- **Music shows its song count twice**: the `big` number is `songs`, and `tracks` in the facts is the same
  number (`home-panels.tsx:32-34`).
- "Recently added" truncates artist names at ~40% width.
- Nothing links to an album or track.
- The page is mostly empty space (owner: "the rest of the page is empty").

### 1.7 Sessions (`/sessions`) — owner: "the worst"

- The top panel is two lines of text: `12.3M in · 1.1M out · $4.20` and a dot-separated model list. There's no
  chart, though **`/api/sessions` already returns `usage` (90 days per day/tool/model) and the page ignores it**
  (`use-sessions.ts:7`).
- "tokens" = `tokensIn + tokensOut`, **excluding cache read/write**, which is 90%+ of real Claude volume. So
  token counts are an order of magnitude off and don't reconcile with cost.
- Cost comes from whatever the tool reported (Claude `cost-state`, OpenCode `cost`), so it's `null` for
  anything else and inconsistent across tools (#94, #95).
- It's a 200-row table with no filter (tool, machine, project, model), no search and no paging.
- Detail view: three copy buttons and a `back` button as equal-weight buttons, then a raw `<pre>` per message.
  Tool calls are bare chips with no input or output. Reasoning isn't shown. User and assistant turns look the
  same, and 4000-character truncation has no "show more".
- AI usage limits (5 h / weekly) live on the jobs page.

---

## 2. Design system

### 2.1 Principles

1. **Ink, not color.** All data is a density of ink on paper. Orange (`--warn`) and red (`--crit`) are the only
   hues, and they mean "near limit" and "at limit / broken". Nothing else gets color: not links, not "ok", not
   charts.
2. **Boxes with edges.** Every section is a box with a 1 px line, on a page background, with an 8 px gap.
   Boxes in a row stretch to equal height and their content is designed to fill it (lists cap to fit, graphs
   flex).
3. **Dither is the texture of data.** Meters, bars, areas, strips and heat squares are ordered (Bayer) dithers
   on an integer pixel grid. Text never sits on dither.
4. **Nothing moves unless the data does.** Every number has a fixed-width slot, and no row wraps on a value
   change.
5. **Everything that names a thing links to it.** An app name opens the app, a site opens the site, an IP
   copies, a tile jumps to its section.

### 2.2 Fonts

**Geist Sans** for prose and labels, **Geist Mono** for everything numeric, every header and every identifier.
Mono-heavy: panel titles, metas, chips, tables of numbers, tabs and nav are all mono.

Replace the Google Fonts link in `src/web/index.html` with:
`https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap`

```css
--font-sans: "Geist", ui-sans-serif, system-ui, sans-serif;
--font-mono: "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace;
```

IBM Plex and JetBrains Mono are dropped: two families that don't share metrics, and Plex's numerals are
narrower than JetBrains', so mixed rows misalign.

### 2.3 Color tokens

Pure monochrome: black, white and true-neutral grays (zero hue, zero saturation), the values of the
pre-redesign Zed Monochrome theme. An earlier warm-paper tint was dropped at the owner's request. No color
scale anywhere: dither density plus an ink ramp (see 2.7) carries magnitude. Orange and red are the only hues
and only mean near limit and at limit. In light mode the page is a step darker than the boxes (`#d9d9d9` under
`#f5f5f5`) so boxes still read as boxes.

| token | dark | light | use |
|---|---|---|---|
| `--bg` | `#101010` | `#d9d9d9` | page background |
| `--card` | `#191919` | `#f5f5f5` | box background |
| `--card-hover` | `#222222` | `#eaeaea` | row/tile hover |
| `--fg` | `#ebebeb` | `#101010` | primary text, ink for dither |
| `--fg-2` | `#c8c8c8` | `#3a3a3a` | secondary values |
| `--muted` | `#999999` | `#666666` | labels, metas (>=4.5:1 on card) |
| `--faint` | `#5c5c5c` | `#a0a0a0` | disabled, axis ticks only, never body text |
| `--line` | `rgba(235,235,235,.15)` | `rgba(16,16,16,.24)` | box borders, table rules |
| `--line-strong` | `rgba(235,235,235,.32)` | `rgba(16,16,16,.46)` | hovered border, inputs, buttons |
| `--ink` | `var(--fg)` | `var(--fg)` | dither "on" pixels |
| `--warn` | `#f0a04b` | `#b86200` | near limit |
| `--crit` | `#f0605a` | `#c42b25` | at limit / down / failed |
| `--focus` | `var(--fg)` | `var(--fg)` | focus ring |

Theme selection: `:root` carries the dark values. Use `@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) {…light} }`
and `:root[data-theme="light"] {…light}`. A 3-state toggle (system / light / dark) sits at the right of the
status bar and stores `keep:theme` in localStorage (try/catch). Set `color-scheme` to match.

### 2.4 Type scale

Only these sizes exist: `--t-11: 11px; --t-12: 12px; --t-13: 13px; --t-14: 14px; --t-16: 16px; --t-20: 20px; --t-24: 24px`.

| role | size / weight / family | line-height |
|---|---|---|
| micro (axis ticks, chip, kbd) | 11 / 400 / mono | 16 |
| label (tile label, dt, th, panel meta, subhead) | 12 / 400 / mono, `--muted` | 16 |
| body (rows, lists) | 13 / 400 / sans; numbers mono | 20 |
| panel title | 13 / 500 / mono, `--fg` | 20 |
| page title | 16 / 500 / mono | 24 |
| tile value | 20 / 500 / mono, tabular | 24 |
| hero value (one per page max) | 24 / 500 / mono, tabular | 28 |

At `min-width: 1400px`, bump the root tokens one step (11→12, 12→13, 13→14, 16→16, 20→24, 24→24) **instead of
`zoom`**. The dither dot size stays 2 px at every width.

Subheads drop to `--muted` (not faint) with a 1 px `--line` rule after them: `volumes ───────`.

### 2.5 Spacing, borders, radius

- Spacing tokens: `--s-1: 4px; --s-2: 8px; --s-3: 12px; --s-4: 16px; --s-5: 24px; --s-6: 32px; --s-7: 48px; --s-8: 64px`.
  Nothing else; `14px`, `18px` and `20px` gaps go.
- Box: `border: 1px solid var(--line); background: var(--card)`. Box gap `--s-2` (8 px). Page padding
  `--s-4` desktop, `--s-4` phone (16 px gutter).
- Radius: `0` everywhere. The global `* { border-radius: 0 }` stays.
- Inside a box: header 36 px tall, padding `0 var(--s-4)`; body padding `var(--s-4)`; vertical rhythm between
  blocks `var(--s-4)`; between list rows `var(--s-2)`.

### 2.6 Fixed-width numbers

Every numeric slot gets a class that fixes its width in `ch` (mono, `tabular-nums`, right-aligned,
`white-space: nowrap`). The formatter must never exceed the slot.

| class | width | max string | formatter |
|---|---|---|---|
| `.n-pct` | 4ch | `100%` | `percent()` |
| `.n-bytes` | 9ch | `1023.9 GiB` → round to `1024 GiB` (≤4 sig figs) | `bytes()` |
| `.n-rate` | 10ch | `999.9 MB/s` | `rate()` |
| `.n-mbps` | 10ch | `999 Mb/s` | `mbps()` |
| `.n-temp` | 4ch | `105°` | `temperature()` |
| `.n-ms` | 7ch | `9999 ms` (≥10 s → `12.3 s`) | `ms()` new |
| `.n-ago` | 7ch | `23h 59m` / `6d 23h` | `duration()` |
| `.n-count` | 7ch | `999.9k` / `9.99M` | `compact()` moved to `lib/format.ts` |
| `.n-usd` | 8ch | `$9999.99` | `usd()` moved to `lib/format.ts` |

Rows that combine values (disk I/O, network rates) are **CSS grids with fixed tracks**, never `flex-wrap`.

### 2.7 The dither technique

#### Matrix and levels

Use the 4×4 Bayer matrix, giving 17 density levels (0..16):

```
B = [[ 0,  8,  2, 10],
     [12,  4, 14,  6],
     [ 3, 11,  1,  9],
     [15,  7, 13,  5]]
```

A pixel at `(x mod 4, y mod 4)` is on at level `L` when `B[y][x] < L`. Level 0 is empty and level 16 is solid.

Value → level: `level(v) = clamp(round(v * 16), vMin, 16)`, where `vMin` is 1 when `v > 0` (so any non-zero
value shows a dot) and 0 otherwise. Some components use a fixed level (see the inventory); the 0..1 mapping is
for density-encodes-value components (heat squares, space squares, day heatmap).

**Dot size: 2 CSS px** (`--dot: 2px`), so one pattern tile is 8×8 CSS px. On 2× screens that's 4 device px per
dot: crisp and visible. At 1× it's 2 device px.

#### Implementation: one SVG `<defs>` sprite

New `src/web/components/dither.tsx` exports `<DitherDefs />`, mounted once in `app.tsx` as an
`<svg width="0" height="0" style="position:absolute" aria-hidden>`. It defines patterns for 3 tones × 17 levels:

```tsx
const B = [[0,8,2,10],[12,4,14,6],[3,11,1,9],[15,7,13,5]];
const TONES = { ink: "var(--ink)", warn: "var(--warn)", crit: "var(--crit)" } as const;
// <pattern id="d-ink-7" width="8" height="8" patternUnits="userSpaceOnUse">
//   one <rect x={2*x} y={2*y} width="2" height="2" style={{fill: TONES.ink}}/> per on-pixel
// </pattern>
export const dither = (level: number, tone: keyof typeof TONES = "ink") => `url(#d-${tone}-${level})`;
```

- `patternUnits="userSpaceOnUse"` with no `patternTransform`: the pattern is anchored to the **SVG's own
  origin**, so adjacent cells in one SVG share a phase, which keeps the texture continuous across bars.
- Tone is set with `style={{ fill: "var(--warn)" }}` on the pattern's rects. CSS custom properties resolve from
  the sprite's position in the document (under `:root`), so the theme switch recolors every pattern with no
  re-render.
- Every data SVG has `shape-rendering="crispEdges"` on the root.
- **Every data SVG is drawn at its real pixel size**: `width`/`height` attributes equal to the measured box,
  `viewBox="0 0 W H"`, and no `preserveAspectRatio="none"`. Measure with a shared `useWidth(ref)` hook
  (ResizeObserver, `Math.floor` the width). All geometry is snapped to multiples of 2 (`snap = v => Math.round(v/2)*2`)
  so dots never split.
- `image-rendering: pixelated` does nothing for SVG; crispness comes from integer geometry, `crispEdges`, and
  no zoom (1.0.1).
- HTML-only spots (the 8 px status square in a chip) don't use patterns; they're solid or outlined.
- `prefers-contrast: more`: swap level-to-pattern for solid fills (`dither()` returns `var(--ink)` when
  `matchMedia('(prefers-contrast: more)')` matches) so low-vision users get plain bars.
- Print: patterns render fine; nothing to do.

Fixed levels used across the system (named constants in `lib/dither.ts`):

| name | level | use |
|---|---|---|
| `TRACK` | 2 | meter/strip track, "no data" |
| `SECONDARY` | 5 | secondary series (upload, write, peaks) |
| `AREA` | 8 | area under a line, normal bars |
| `FILL` | 12 | meter fill |
| `SOLID` | 16 | line tops, "up" cells, the edge of a meter |

#### Legibility: density plus an ink ramp, five steps for squares

Two neighbouring Bayer levels (say 6 and 8) are nearly impossible to tell apart, so density never encodes a
value on its own:

- **Ink ramp.** Every pattern's on-pixels get an opacity that rises with the level (`inkAlpha` in
  `lib/dither.ts`: about 38 % at level 1, 69 % at 8, 83 % at 12, 100 % solid). Sparse reads as light *and*
  thin, dense as dark *and* full. It lives in `DitherDefs`, so every chart, meter and square gets it in both
  themes with no per-component work.
- **Five steps for value squares.** Heat squares, space squares and day maps quantise to `HEAT_STEPS`
  (`TRACK, 4, 8, 12, SOLID`): none, up to 1/4, up to 1/2, up to 3/4, above. `densityLevel` does this.
- **A legend wherever levels encode values.** `HeatMatrix` takes `format` and prints `<HeatScale>`
  (`0 ▫▫▫▫▪ $12+`), each square titled with its exact range.
- **Exact values on hover.** Every square and bar has a tooltip or `title` with the real number; the ramp is
  for scanning, the tooltip is for reading.
- Overlays drawn inside a bar (blocked over queries) use `FILL`, never a lower level: Bayer pixels nest, so a
  lighter level inside a denser bar disappears.

### 2.8 Component inventory

All new or rewritten components live in `src/web/components/`. Sizes are CSS px at the base scale.

#### Box (`panel.tsx`, rewritten)

```
┌─ ■ cpu ─────────────────────────── i5-8400 · 6 cores · 32% ┐  36px header
│                                                             │
│  body (padding 16)                                          │
└─────────────────────────────────────────────────────────────┘
```

- Props: `id` (anchor, required on home), `title`, `meta`, `actions` (right-aligned slot for links/tabs),
  `href` (makes the title a link with `→`), `area` (grid area), `flash` (boolean).
- Header: title 13/500 mono `--fg`, preceded by a 6×6 square at level 8 (dither). Meta is 12 mono `--muted`,
  ellipsis. Bottom border 1 px `--line`.
- Body: `display:flex; flex-direction:column; gap:16px; flex:1`. The box is `height:100%` so grid rows
  stretch. The last child gets `margin-top:auto` when it's a footnote (`.box-foot`, 12 mono muted, top rule).
- **Section highlight** (`.is-flash`): border becomes `1px solid var(--fg)`, the header inverts (bg `--fg`,
  text `--card`) for 1200 ms, then transitions back over 400 ms. Respect `prefers-reduced-motion`: no
  transition, just a 1200 ms state.

#### Stat tile (`stat-tiles.tsx`)

```
┌──────────────────┐
│ cpu          ↘   │ 12 mono muted + jump glyph on hover
│ 32%              │ 20/500 mono, tone class
│ load 1.66        │ 12 mono muted, 1 line, ellipsis
│ ▓▓▒▒░▓▓▒▓▓▓▒░▒▓  │ 24px dither micro-chart (last 120 s) or meter
└──────────────────┘
```

- Always a `<button>` (or `<a>` for routes). Click scrolls to its section and flashes it (see Layout §3.4).
  The `↘` glyph shows on hover/focus.
- Height fixed 104 px. The value slot is a fixed-width class, so the tile never reflows.
- Micro-chart: a dither **column chart** (one 2 px column per sample, 60 samples, level 8, solid 2 px top
  pixel). Ratio tiles use the dither meter (below) at 8 px tall.
- Tone (warn/crit) colors the value text and the chart pattern; the label stays muted.

#### Dither meter (`meter.tsx`, rewritten)

```
████████▓▓▓▓▓▓▓▓▒▒▒▒░░░░  ·  ·  ·  ·  ·  ·  ·  ·  ·
└ fill: level 12, 2px solid leading edge ┘└ track: level 2 ┘
```

- SVG, height 8 px (tiles, rows) or 12 px (memory). Width = container, measured.
- Track: full width at `TRACK` (level 2, ink).
- Fill: `snap(width*v)` px at level `FILL` (12) in the value's tone (ink, warn, or crit by thresholds), plus a
  2 px `SOLID` edge at its right end.
- Stacked segments (memory used + cache): used at level 12, cache at level 5, available as track.
- Threshold ticks: optional 1×8 px `--line-strong` lines at warn and crit ratios (`ticks` prop), so you can see
  how far from the limit you are.
- Keep `role="meter"` and the aria values.

#### Dither column / bar chart (`dither-bars.tsx`, new)

For journal hours, SMART daily writes, DNS hourly, speed tests, and session cost per day.

- Props: `values: (number|null)[]`, `overlay?: (number|null)[]` (errors over lines, blocked over queries),
  `max?`, `height` (40 default), `format`, `labels?: string[]` (x labels), `onPick?(index)`.
- Column width = `snap((W - gaps) / n)`, min 2 px, gap 2 px. If columns would be under 2 px, aggregate
  (max) to fit.
- Bar: `AREA` level ink, with a 2 px `SOLID` cap. Overlay: drawn on top from the baseline at `FILL` level in
  `crit` (errors) or in ink at `SECONDARY` (blocked).
- Null renders as a 2 px `TRACK` stub at the baseline (visibly "no data", unlike zero, which is nothing).
- Axis: no gridlines. Top-right micro label with the scale max (`11 mono faint`); x labels at the first, the
  middle and the last column only.
- Hover/focus: the column gets a 1 px `--fg` outline and a tooltip box (`--card`, 1 px `--line-strong`,
  12 mono) with label and value. Arrow keys move between columns.

#### Dither sparkline / area (`sparkline.tsx`, rewritten)

- Same props as today (`SeriesView` plus `max`, `minTop`, `format`, `height`, `label`).
- Rendered as **columns, not a polyline**: one column per pixel-pair (2 px). The value per column is the max
  of the samples falling in it (keeps peaks). Column body at `AREA`, top 2 px at `SOLID` (the "line").
- **Secondary series** (tx, write, peaks): mirrored **below** a 1 px `--line` baseline at the vertical center
  for traffic (rx up, tx down), each half scaled independently and labelled `↓ in` / `↑ out` at the left edge.
  For "peaks under averages" (long ranges), peaks are drawn above the avg column at `SECONDARY` level, not
  mirrored.
- Gaps (null) are empty columns with a 2 px `TRACK` baseline stub.
- Scale label: top-right, 11 mono faint. No dashed midline (drop `.sparkline-mid`).
- Hover readout stays (time + value), rendered as the tooltip box.
- Height tokens: 24 (tile), 48 (row), 96 (primary graph). Never stretch-to-fit.

#### Heat square grid (`heat-grid.tsx`, new)

One component with three uses: per-core CPU, temperatures, space-per-app.

```
 c0   c1   c2   c3   c4   c5
┌──┐ ┌──┐ ┌──┐ ┌──┐ ┌──┐ ┌──┐    load   (density = usage)
│▓▓│ │░░│ │▒▒│ │░░│ │▓▓│ │░░│
└──┘ └──┘ └──┘ └──┘ └──┘ └──┘
 4%  15%   5%   5%   5%   4%
┌──┐ ┌──┐ ┌──┐ ┌──┐ ┌──┐ ┌──┐    temp   (density = (t-30)/(95-30))
│▒▒│ │▒▒│ │▒▒│ │▒▒│ │▒▒│ │▒▒│
└──┘ └──┘ └──┘ └──┘ └──┘ └──┘
 42°  41°  42°  41°  41°  41°
```

- Props: `cells: {key, label, value01, text, tone?, href?, title?}[]`, `size` (24 desktop, 32 phone; any
  multiple of 8), `columns?`.
- Cell: SVG square `size×size`, 1 px `--line` border, filled with `dither(level(value01), tone)`.
  Label above (11 mono muted), text below (12 mono, fixed-width class).
- `href` makes the whole cell an `<a>` (new tab for external). Hover: border `--fg`, tooltip with full detail.
- Tone by thresholds: CPU `USAGE`, temp `HEAT` (on °C/100, as today), space `QUOTA`.

#### Uptime strip (`uptime-strip.tsx`, replaces `Bars` in `uptime-page.tsx`)

- N cells (48 / 84 / 90 for 24h / 7d / 30d), each `cellW` = `snap((W - (N-1)*1) / N)`, min 4 px, gap 1 px,
  height 16 px desktop, 20 px phone.
- Up ≥ 99.9%: `SOLID` ink. Partial: `dither(level(upRatio), "warn")`, so the more down, the sparser.
  0% up: `SOLID` crit. **No data: `TRACK` (level 2) with no border**, visibly hollow and different from every
  data state.
- Hover/arrow-key tooltip as today (range, % up, down minutes from `/api/minutes`).

#### Day heatmap (`day-heatmap.tsx`, new)

GitHub-style, used for session cost (90 days) and activity events (7 days × 24 hours).

- Columns = weeks (or days), rows = weekday (or hour). Cell 12 px, gap 2 px (desktop); 10 px with 2 px gap on
  phone.
- Density = `value / p95(values)` clamped to 1 (p95, not max, so one big day doesn't flatten the rest).
  Zero = `TRACK`.
- Hover: tooltip `Tue 18 Nov · $4.21 · 41 sessions`. Click: applies that day as a filter on the list below.
- Month labels above (11 mono muted), weekday labels left (Mon/Wed/Fri only).

#### Table (`.table`)

- 13 px body, header 12 mono muted with no uppercase, 1 px `--line` bottom rule on rows, row height 36 px
  desktop / 44 px phone.
- `table-layout: fixed` with explicit `<colgroup>` widths, so columns align across sibling tables (fixes the
  apps drift).
- Numeric columns right-aligned with fixed-width classes. Hover row: `--card-hover`.
- A clickable row is an `<a>` in the first cell, stretched to the row via `::after { inset:0 }`, so the whole
  row is a target with real link semantics.

#### Chip / status (`chip.tsx`, `status-square.tsx`)

- Chip: 20 px tall, padding 0 6, 1 px `--line-strong`, 11 mono `--muted`. Variants: `solid` (bg `--fg`, text
  `--card`), `warn` (border and text `--warn`), `crit`.
- Status square, 8×8: ok = solid `--fg`; warn = solid `--warn`; down = solid `--crit`; none = 1 px `--faint`
  outline. Always paired with text on phone (never color alone).
- **Uptime rows show the 24 h ratio's tone on the square** if it's worse than now. The square has a title/aria:
  `up now · 97.43% over 24h`.

#### Copy-on-click value (`copy-value.tsx`, new)

```
lan 192.168.1.10 ⧉    →    lan copied ✓
```

- A `<button class="copy">` showing `label value`, value in mono. A glyph `⧉` appears on hover/focus.
- On click: `navigator.clipboard.writeText(value)`. The value text is replaced by `copied` for 1200 ms, with an
  `aria-live="polite"` announcement. On failure it shows `select` and selects the text.
- Touch target ≥44 px tall on phone (padding), with the visual height unchanged on desktop.
- Used for LAN, tailscale and public IPs, device IPs, MACs, session ids, job names, cursors in logs, and
  `keep-sessions pull` commands.

#### Filter / search / sort bar (`filter-bar.tsx`, new)

```
[ search apps…          / ]  [all 24][running 21][failing 1][previews 3]   sort: [name ▾]  [▦ ▤]
```

- Search: input 32 px tall (44 on phone), 1 px `--line-strong`, 13 mono, placeholder muted. `/` focuses it,
  `Esc` clears.
- Filters: segmented chips with counts, one active (`solid`). Multi-select where noted.
- Sort: native `<select>` styled as a chip (keeps the OS picker on phone).
- State lives in the URL query (`?q=&f=&sort=`) via `router.ts`, so views are linkable.
- Phone: search full width on row 1, chips horizontally scrollable on row 2 (`overflow-x:auto` inside the bar
  only, with a fading mask on the edge), sort as an icon button.

#### Tabs (`page-header.tsx` `Tabs`)

- Segmented control: 28 px (44 on phone), 1 px `--line-strong`, the active segment solid `--fg` with `--card`
  text, 12 mono.
- Used for ranges (live/1h/24h/7d/30d), uptime range, and log priority. Arrow keys move, and
  `role="tablist"` is kept.

#### Empty state (`.empty`)

- A 2-line block: an icon-free 12 mono muted statement plus an optional action link.
  `nothing playing · open navidrome →`
- Inside a box it's vertically centered in the remaining space. Never shown in faint, never as the only
  content of a box taller than 160 px (the layout must shrink the box instead, §3).

#### Link affordance

- Internal link: text `--fg` with a 1 px `--line-strong` underline (`text-underline-offset: 3px`). Hover: the
  underline turns `--fg`.
- External link: same plus `↗` (11 mono muted) after it, `target="_blank" rel="noreferrer"`.
- Row links: see Table. Box title links: `title →`.
- `:focus-visible`: `outline: 1px solid var(--focus); outline-offset: 2px` everywhere.

#### Section highlight on tile click

See Box `is-flash` and §3.4.

#### Log viewer row (`log-row.tsx`, new)

```
11-27 14:03:22.118  E  keep-disk-watch    disk /srv at 76% (warn 75%)                       ⌄
```

- Grid columns: time `15ch` (`MM-DD HH:MM:SS.mmm`, local, mono 12 muted) · priority `2ch` (letter: E C A W N I D,
  colored only for ≤3 crit and 4 warn) · source `18ch` (ellipsis, clickable: adds a source filter) · message
  `1fr` (13 mono, single line, ellipsis) · expand `24px`.
- Row height 28 px desktop, 36 px phone. On phone the message moves to its own line under time, prio and
  source.
- Click or Enter expands: message wrapped in full, then a 2-column key/value list of all journal fields
  (`_SYSTEMD_UNIT`, `_PID`, `_HOSTNAME`, `_BOOT_ID`, `__CURSOR` with copy), plus `show context`, which loads
  ±50 lines around the cursor.
- Matches of the query are wrapped in `<mark>` (bg `--fg`, color `--card`).

---

## 3. Layout system

### 3.1 Frame

```
┌ title bar 40px: hostname · os · kernel ················· up 6h · procs 1233 · 23:24:02 · ■ live ┐
├ sidebar 200 ┬ page (scrolls) ─────────────────────────────────────────────────────────────────┤
│ the keep    │ page header 56px: title · meta ·················· [range tabs] [actions]        │
│  home       │ ┌ box ┐ ┌ box ┐                                                               │
│ infra       │                                                                               │
│  uptime     │                                                                               │
│  apps       │                                                                               │
│  jobs       │                                                                               │
│  logs   NEW │                                                                               │
│  activity   │                                                                               │
│ personal    │                                                                               │
│  media      │                                                                               │
│ ai          │                                                                               │
│  sessions   │                                                                               │
├─────────────┴───────────────────────────────────────────────────────────────────────────────┤
│ status 28px: lan 192.168.1.10 ⧉  tailscale 100.64.0.10 ⧉  public 203.0.113.7 ⧉ ····· ◐ theme  │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

Title bar: add a 40×12 px dithered sparkline of the last 120 s of CPU next to `■ live`. That's the only
decoration and it carries data. The reference's canvas pixel-sky background is **dropped**: behind a
1-second-refresh, data-dense page it's noise that competes with the dither charts and costs a full-viewport
canvas repaint. The dithered title-bar strip is the nod to it.

### 3.2 Desktop grid

- Page content: 12 columns, `gap: 8px`, `padding: 16px`, `grid-auto-rows: auto`, `align-items: stretch`.
  Boxes are full-height in their row.
- Breakpoints: `≥1100px` 12 cols; `721–1099px` 6 cols (every 12-col span halves, 4-col items become 6); `≤720px` 1 col.
- **Row-pairing rule:** two boxes may share a row only if their natural content heights are within ~25%. Each
  page's wireframe lists its pairs; the engineer must check with real data and move a box to a full row rather
  than leave a hole. Lists inside paired boxes take `max-rows` props computed to fill (e.g. internet shows 6
  tests because the network box is ~6 rows tall).
- Max content width: none. The grid stretches. At ≥1800 px, charts get more columns, not more height.

### 3.3 Phone rules (≤720 px; designed at 390)

- Single column, 16 px gutters, 8 px gap between boxes, no horizontal page scroll. Only filter chip rows and
  code/log bodies may scroll horizontally, inside their own box.
- Title bar: hostname plus `■ live` only. The status bar is **hidden**; IPs move into the home "host" box.
- **Bottom nav: 5 slots**, each 64 px tall including the safe area (`padding-bottom: env(safe-area-inset-bottom)`),
  icon 16 px above an 11 mono label, all labels shown: `home · uptime · apps · logs · more`. `more` opens a
  bottom sheet listing jobs, activity, media, sessions and the theme toggle, each row 52 px. The active slot
  gets a 2 px top bar in `--fg`. A slot shows a crit dot if any page inside it has alerts.
- Touch targets ≥44×44 px: tabs, chips, buttons, copy values, table rows, heat cells (32 px visual plus 6 px
  padding), nav. Text links inside prose are exempt.
- Tables become **stacked rows**: line 1 is status, name and primary value; line 2 is muted secondary values.
  No `.hide-narrow` that removes information users need (uptime strips stay; see Uptime).
- Tiles: 2 columns, 88 px tall, micro-chart kept.
- Fixed-width number classes apply unchanged. Values never wrap; labels ellipsize.

### 3.4 Tile → section jump

1. Every home box has `id` = its tile key (`cpu`, `memory`, `storage`, `temperature` → the cpu box's temps row
   `#temps`, `network`, `sites`, `dns`, `internet`).
2. Tile click: `history.replaceState(null, "", "#cpu")`, then
   `el.scrollIntoView({ block: "start", behavior: reducedMotion ? "auto" : "smooth" })`, accounting for the
   sticky page header with `scroll-margin-top: 64px` on boxes. Then set `flash` on that box for 1600 ms.
3. On page load with a hash, do the same once data has arrived.
4. Sub-targets (`#temps`) flash only their sub-block: a 1 px `--fg` outline with 4 px offset.

---

## 4. Pages

Notation: `[n]` = column span on the 12-col grid. `NEW DATA` = needs a server/agent change, specified inline.

### 4.1 Home `/`

Purpose: the machine at a glance (tiles), then one box per subsystem, **each shown once**.

**Changes in substance:**

- The tiles are the headline numbers. **Boxes drop their 30 px `big` headline** and put the current value in
  the header meta instead (`cpu · i5-8400 · 6 cores · 32%`). That ends the duplication.
- CPU and temperatures merge: per-core load and per-core temp are aligned columns (heat grid). Non-core sensors
  (board, dimms, nvme, package) form a second short heat row in the same box. The temperatures box is deleted.
- Storage splits into **volumes** (usable mounts only) and **disk i/o**. The backup HDD is shown on its own
  line under volumes, labelled `backup · not counted`, and **excluded from the total**.
- Space becomes a heat-square grid that links each app.
- The containers table goes. See "containers" below.
- A **host** box (phone: first; desktop: in the status bar) carries the copyable IPs.

Desktop wireframe (1440 px, content ≈1208 px):

```
┌cpu────┐┌memory─┐┌data disk┐┌temp──┐┌network┐┌sites─┐┌ads───┐┌internet┐   tiles: 8 × [1.5], 104px
│32%    ││5.6 GiB││3%       ││43°   ││117KB/s││27/27 ││17%   ││94 Mb/s │   each jumps to its box
│load1.6││of 30  ││913 free ││hot.. ││↑447K/s││all up││1277/7k││↑31·9ms│
│▓▒░▓▓▒▓││█▓▓▓···││█·······││██▓···││▁▂▁▅▁▂ ││      ││▓▓▓░░░││▁▂▂▃▂▂ │
└───────┘└───────┘└─────────┘└──────┘└───────┘└──────┘└──────┘└────────┘
┌■ cpu · i5-8400 · 6 cores · 32% · 3.80 GHz · load 1.66 1.83 1.69 [8]─┐┌■ memory · 30 GiB · 18% [4]────┐
│ 100%                                                    [96px area] ││ ████████▓▓▓▓▓▓▓▓▓▓▓··········· │ 12px stacked
│ ▁▂▃▂▅▃▂▁▂▃▄▃▂▂▃▅▃▂▁▂▃▂▃▄▂▁▂▃▂▃▄▃▂▁▂▂▃▂▂▃▄▃▂▁▂▃▂▃▄▃▂▂▃▂▃▄▂▁▂▃▂▃▄▃▂▁ ││ used     5.6 GiB  cache  24 GiB│ 2×2 legend grid
│ cores    c0   c1   c2   c3   c4   c5                                ││ avail     25 GiB  swap 0/8 GiB │
│ load    [▓▓] [░░] [▒▒] [░░] [▓▓] [░░]                               ││                                │
│           4%  15%   5%   5%   5%   4%                               ││ ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁ [96px]  │ same height as cpu graph
│ temp    [▒▒] [▒▒] [▒▒] [▒▒] [▒▒] [▒▒]   pkg [▒▒] board[░░] dimm[▒▒▒▒]││ zram, top 3 by mem (NEW, opt.) │
│          42°  41°  42°  41°  41°  41°        43°       28°   36° 36° ││                                │
└─────────────────────────────────────────────────────────────────────┘└────────────────────────────────┘
┌■ network · ↓ in ↑ out [6]──────────────────┐┌■ internet · your isp · every 4h [6]──────────────────────┐
│ lan enp5s0 · 1 Gb/s   ↓ 138.0 KB/s ↑ 164 KB│ │ ↓ 93.8 Mb/s   ↑ 30.7 Mb/s   9 ms   tested 2h 24m ago    │
│ ▁▁▁▁▁▁▁▁▅▁▁▁▁  (rx up)                     │ │ ▃▃▄▃▃▃▂▃▃▄▃▃▃▃▃▄▃▃▃▃▃▄▃▃▃▃ (42 tests, dither cols)  │
│ ─────────────────────────────────────────  │ │ when        down        up      ping                 │
│ ▔▔▔▔▔▔▔▔▀▔▔▔▔  (tx down)  since boot ↓9 ↑1.5│ │ 14:00    93.8 Mb/s  30.7 Mb/s   9 ms                 │
│ tailscale0 · virtual  ↓ 125 KB/s ↑ 144 KB/s│ │ 10:00    94.1 Mb/s  31.0 Mb/s   9 ms                 │
│ (same block)                               │ │ 06:00 … (fills to box height, max 6)                 │
└────────────────────────────────────────────┘└──────────────────────────────────────────────────────┘
┌■ volumes · 36 GiB / 1.1 TiB usable [6]─────┐┌■ disk i/o [6]──────────────────────────────────────────┐
│ system  /       ███▓▓·········  11/216 GiB 5%││ sda  TEAM T2531TB · 954 GiB · /srv        33°      │
│ data    /srv    █▓············  25/938 GiB 3%││  read   0 B/s  write 4.1 KB/s  1 iops  busy 0%     │ fixed grid
│ ── backup (not counted) ───────────────────  ││  ▁▁▁▁▃▁▁▅▁▃▁▁▁  /  ▔▔▔▔▔▔▔▔ (mirrored, 48px)         │
│ backup  /srv/backup-hdd ████▓▓▓··· 700/1.8 TB ││ sdb  TEAM T253X1240G · 224 GiB · /              │
│         last backup 6h ago · next 03:00       ││  …                                                 │
└────────────────────────────────────────────┘└──────────────────────────────────────────────────────┘
┌■ disk health · 3 ok [6]────────────────────┐┌■ ad blocking · adguard on · 17% [6]─────────────────────┐
│ sda  ssd  passed  98% life  12.1 TB  41 GB/d│ │ 7,358 queries · 1,277 blocked · 98.7 ms avg         │
│      ▂▃▂▂▃▄▂▂▃▂▂▃▂▂▃▄▂▂▃▂▂▃▂▂▃▄▂▂▃▂ 30d writes│ │ ▂▂▂▃▃▄▅▃▂▂▂▃▃▄▅▃▂▂▂▃▃▄▅▃ (24h, blocked overlay)       │
│ sdb  ssd  passed …                          │ │ most blocked: api.segment.io 566 · dit.whatsapp 468 │
│ sdc  hdd  asleep · 0 bad sectors · 34°      │ │ … (fills to height, max 5)                          │
└────────────────────────────────────────────┘└──────────────────────────────────────────────────────┘
┌■ space · 913 GiB free on /srv · alerts at 80% [12]────────────────────────────────────────────────────┐
│ apps                                                                                                  │
│ [▓▓]photos   [▒▒]drive   [░░]music   [··]passwords  [░░]bookmarks …  each 24px square = used/limit,     │
│  926M/150G   3.4G/50G    505M/200G   760K/1G        …                  links to the app, ⛬ hard limit  │
│ garage buckets · healthy                                         browse buckets →                      │
│ [░░]dev 0/30G  [▓▓]turbo-cache 17.8/20G (warn)  [░░]photos 900M/–  …   each links to /buckets/<name>   │
└───────────────────────────────────────────────────────────────────────────────────────────────────────┘
┌■ sites · 17/17 up · kuma [8]────────────────────────────────┐┌■ containers · 31/31 running [4]────────┐
│ ■ dokploy    dokploy.findmalek… ↗   ▁▂▁▁▂▁ 32 ms   99.98%   ││ running ████████████████ 31             │
│ ■ photos     photos.…           ↗   ▁▁▁▂▁▁ 23 ms  100%      ││ unhealthy · 0   stopped · 2             │
│ …  (2 columns on ≥1600px)                                    ││ needs attention                         │
│ ■ dns        home → 203.0.113.7 · public 203.0.113.7 · ok  ││  ■ minecraft  stopped (switch, asleep)  │
│                                              all checks →    ││ top by memory                           │
└─────────────────────────────────────────────────────────────┘│  seafile 1.2 GiB · stirling 897 MiB …   │
                                                               │                     all apps →          │
                                                               └─────────────────────────────────────────┘
┌■ system log · 12 lines/min · 412 MiB / 1 GiB [12]─────────────────────────────────── open logs → ┐
│ ▂▂▃▂▂▂▂▃▅▃▂▂▂▂▃▂▂▂▂▃▂▂▂▂  24h lines/hour, crit overlay = errors; click a bar → /logs?since=…&until=… │
│ loudest last hour: dockerd 4,120 · kernel 880 · keep-agent 412 · traefik … (each → /logs?source=x)   │
└────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Panel notes:

- **cpu [8] + memory [4]**: same height by construction (both have a 96 px graph and two ~56 px rows of
  detail). The CPU graph follows the page range tabs. Core heat squares are 24 px. Temps use
  `HEAT` tone. Sensors are grouped by `group` (`cpu` → aligned under cores by index when labels are
  `core N`; others in the trailing group). If the core counts differ (hyperthreads: 12 load cores vs 6 temp
  sensors), temp squares span 2 load columns (`core i` temp under load columns `2i, 2i+1`).
- **network [6] + internet [6]**: internet lists the last `min(6, rows that fit)` tests from
  `internet.history`, newest first. The tested time is a link to Speedtest Tracker (`NEW DATA`: add
  `speedtest` to `Links`, env `SPEEDTEST_PUBLIC_URL`).
- **volumes [6] + disk i/o [6]**: the volumes total excludes backup (`NEW DATA`: `MountStats.role: "data" | "backup"`
  from a new env `BACKUP_MOUNTS=backup` (labels), default `backup`; `collectors/storage.ts` sets it). Long paths:
  the path renders in 11 mono muted on its own line under the label when the label column is narrower than
  its text (CSS: `.vol-label { display:grid }`), never wrapping mid-path. Disk i/o rows use a 5-track grid:
  `read 10ch | write 10ch | iops 7ch | busy 4ch | temp 4ch`, so the jump bug is gone. The backup line shows the
  last backup from `jobs.backup` (already in the snapshot).
- **disk health [6] + ad blocking [6]**: SMART `passed` becomes the ok status square plus the text `passed`
  (no undefined class). Write bars use `dither-bars` with a scale label (`max 120 GB`).
- **space [12]**: the heat grid of `usage.items` (density = used/limit; no limit → `TRACK` plus text
  `no limit`). Hard limit: a small solid 4×4 corner notch at the top-right of the square, plus legend text
  `◪ hard limit (app refuses writes)`. That replaces the hover-only tooltip. Each square links to the app
  (`NEW DATA`: `UsageItem.url?: string`, written by `keep-usage`; until then the client maps `item.label` to
  the `AppService` whose name matches and uses `https://${domains[0]}`). Garage buckets (`snapshot.garage.buckets`)
  form a second row linking to `/buckets/<name>`. Explicit links the owner asked for: drive (seafile),
  music (navidrome), passwords (vaultwarden), photos (ente), so these four must resolve.
- **sites [8]**: rows link to `monitor.url` (new tab). Columns: status, name, host ↗, a 48 px response
  sparkline (`kuma:<id>:ms`, 24h range, fetched once with the uptime keys), ms, 24 h %. The useless `status`
  column is removed. DNS row: compares the public IP with the record resolved via **1.1.1.1** (`NEW DATA`:
  in `collectors/system.ts` `resolveIp`, use `new Resolver()` with `setServers(["1.1.1.1", "9.9.9.9"])` and
  `resolve4`, not `lookup()`), which kills the false red.
- **containers [4]**: justified as *the docker daemon's view*, distinct from apps (Dokploy's view) and uptime
  (checks): it catches containers Dokploy doesn't manage. It shows a running/total meter, counts by state,
  **only** containers that are not running or unhealthy (with the reason), then the top 3 by memory, then a
  link to `/apps`. With nothing wrong, the "needs attention" block reads `nothing · all healthy`. If you want
  it gone, deleting it loses nothing the apps page doesn't cover except unmanaged containers, which the
  cleanup panel already lists.
- **system log [12]**: bars clickable into `/logs`, top sources link to `/logs?source=`.

Pairs to verify with real data: cpu|memory, network|internet, volumes|disk i/o, health|dns, sites|containers.

Phone order (each box full width):

```
host (NEW box: hostname · up 6h · kernel; lan/tailscale/public copy rows, 44px each; dns status)
tiles 2×4
cpu (graph 72px; core squares 32px, 6 per row = 6×32+5×8=232px ✓)
memory
storage: volumes then disk i/o (two boxes)
internet → network → ad blocking → disk health
space (squares 32px, 4 per row with labels under)
sites (stacked rows: name ↗ / ms · 24h%) → containers → system log
```

The range tabs move into a sticky 44 px bar under the page header, scrolling horizontally if needed.

### 4.2 Uptime `/uptime`

```
uptime · 27/27 up · checked every 60s · alerts via ntfy           [24h|7d|30d]  [edit checks ↗]
┌■ summary [12]───────────────────────────────────────────────────────────────────────────────┐
│ 27 checks · 0 down · worst: keep dashboard 94.44% · 3 certs < 30d                            │
│ all checks, one row: ████████████▓▓██████████████▒██████  (min uptime per bucket across checks)│
└────────────────────────────────────────────────────────────────────────────────────────────────┘
┌■ sites · 17 [12]─────────────────────────────────────────────────────────────────────────────┐
│ ■ dokploy  dokploy.findmalek… ↗ │████████████████████████████▓▓▒█│ ▁▂▁▃▁ 32 ms │ 97.43% │ 89d  │
│ ■ photos   photos.…           ↗ │…                               │             │        │      │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
┌■ containers · 10 [12]──── same columns, same colgroup ────────────────────────────────────────┐
```

- Range picker `24h | 7d | 30d` (#102) in the page header, stored as `?range=`. Buckets: 24h → 48 × 30 min;
  7d → 84 × 2 h; 30d → 90 × 8 h. Data: `/api/history?range=…&keys=kuma:<id>:up,kuma:<id>:ms` (exists).
  `/api/minutes` allows at most 2 h, so for 7d/30d the hover detail shows only `% up` and skips minute-level
  outages. Alternatively raise the limit to 8 h (`server.ts:274`). Recommended: raise it to 8 h.
- Columns: status · check (name + host ↗, links to the URL) · strip (flex) · response sparkline + current ms ·
  uptime **for the selected range** (computed from the buckets, the average of non-null values) · cert days.
  The separate 24h/30d columns go. Kuma's own `uptime30d` shows in the tooltip only.
- The summary strip is the per-bucket minimum across all checks. Clicking a bucket scrolls to the first check
  that was down in it.
- Sort: worst uptime first (toggle: by name). Filter chips: `all · down · degraded · certs`.
- Phone: one stacked row per check: line 1 is status, name and range %; line 2 is the full-width strip (48 cells
  × 6 px + gaps = 335 px, fits 358); line 3 is `32 ms · cert 89d · host ↗`. **The strip is never hidden.**
  For 7d/30d on phone, use 48 cells (re-bucketed) to fit.

### 4.3 Apps `/apps`

```
apps · 24 services · 7 projects · 1 needs attention
[search…  /] [all 24][running 21][failing 1][stopped 2][previews 3]   group:[project▾] sort:[name▾]
┌■ pinned · infrastructure ★──────────────────────────────────────────────────────────────────────┐
│ ┌garage ↗───────────┐ ┌uptime-kuma ↗──────┐ ┌dashboard ↗────────┐ ┌adguard ↗──────────┐            │
│ │■ running 1/1      │ │■ running 1/1      │ │■ running 1/1      │ │■ running 1/1      │  cards     │
│ │s3.findmalek… ↗    │ │kuma.… ↗           │ │keep.… ↗           │ │dns.… ↗            │  4 per row │
│ │cpu  ▓░░░░░░  0%   │ │cpu  ░░░░░░░  0%   │ │…                  │ │                   │  @1440     │
│ │mem  ▓▓░░░░ 71 MiB │ │mem  ▓▓▓░░ 143 MiB │ │                   │ │                   │            │
│ │deployed 6h ago·2s │ │deployed 3h ago    │ │                   │ │                   │            │
│ │compose · object st│ │compose · monitors │ │                   │ │                   │            │
│ └───────────────────┘ └───────────────────┘ └───────────────────┘ └───────────────────┘            │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
┌■ games ★ ───── (pinned) ──────────────┐
┌■ personal ──────────────────────────── (unpinned projects alphabetical) ─────────────────────────┐
┌■ previews & staging · 3 ──── collapsed by default ──── ceraghit pr-41 · lodesong pr-12 … ─────────┐
┌■ cleanup log · last run 4h ago · removed 12 ─── collapsed by default (existing CleanupPanel) ─────┐
```

- **Card** (min 240 px, `grid-template-columns: repeat(auto-fill, minmax(240px, 1fr))`, height fixed 148 px):
  - line 1: status square, service name (links to the Dokploy service, `service.url`, new tab), kind chip on
    the right;
  - line 2: primary domain ↗ (new tab) `+N` chip, and a popover with all domains on click;
  - line 3 and 4: cpu and mem dither meters (cpu ratio, mem against a 2 GiB visual max, or the container limit
    when known), fixed-width values;
  - line 5: `deployed 6h ago · 2s` (crit if failed), the deploy title in the tooltip;
  - line 6: description from `descriptionFor()` (muted, 1 line, ellipsis). **Visible**, not hover-only.
  - Databases (postgres/redis/…) render as compact cards (88 px: name, status, mem) in a trailing row.
- **Pin**: ★ toggle on the project header. Defaults: `infrastructure` and `games` pinned. Stored in
  localStorage `keep:apps:pins` (per browser; one user). Pinned projects come first, always expanded.
- **Previews/staging grouping**: a service is a preview if its environment name is not `production`, or its
  name matches `/-pr-\d+$|preview/i`. All of them go into one collapsed "previews & staging" group, sorted by
  last deploy, each card showing its PR number when parseable.
- Filters and search (`name`, domain, description) via the filter bar; counts update live. Sort: name, cpu,
  memory, last deploy, status (failing first). `group: project | none` (none = a flat card grid).
- Phone: 1 card per row (full width, 132 px), filter bar as in §2.8.

### 4.4 Jobs `/jobs`

```
jobs · 9 scheduled · 1 failed · times in utc
┌ how this works ────────────────────────────────────────────────────────────────────────────── × ┐
│ each job is a systemd timer on the host. keep-agent reads them every minute into jobs.json;    │
│ "run now" drops a request the agent checks against an allow-list. logs come from the journal. │
└────────────────────────────────────────────────────────────────────────────────── (dismissible)┘
┌■ scheduled [8]──────────────────────────────────────────────────┐┌■ server [4]──────────────────┐
│ ■ keep-cleanup  prunes old dokploy deploys  daily 04:30  5h ago ▸ ││ backups ■ ok · 6h ago · 4 GiB│
│   last run  ·  previous run                        [run now]   ││ tidy up  last 5h ago, freed  │
│   ┌ log: run 2026-11-27 04:30:00 · 0.8s · success ───────────┐  ││   150 MiB          [tidy now]│
│   │ 04:30:00.112 I removed 12 deployments (ceraghit…)        │  ││ minecraft asleep    [start]  │
│   │ 04:30:00.840 I done                                      │  ││ reboot  ~90s       [reboot]  │
│   └──────────────────────────────────────────────────────────┘  │└──────────────────────────────┘
│ ■ keep-tidy …                                                ▸ │┌■ github runners [4]──────────┐
│ □ dokploy-docker-cleanup  scheduled by dokploy, no logs here   │└──────────────────────────────┘
└─────────────────────────────────────────────────────────────────┘
┌■ recent actions · last 20 [12]──────────────────────────────────────────────────────────────────┐
│ 14:02  run:keep-tidy  ■ done  by MacBook Pro (tailscale)  took 12s  freed 2.1 GiB      output ▸ │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- Job row (collapsed, 44 px): status, name (mono), description, schedule (muted), last run `n-ago` (crit if
  failed) with duration **only if ≥1 s**, next run, then `▸`. `run now` moves **into the expanded row** (it
  stops shouting 7×). Expanded: tabs `last run | previous run`, then a log viewer (log rows, max 500 lines,
  scrollable 320 px) with a header `started · duration · result · exit code`, then `open in logs →`
  (`/logs?unit=<name>.service&since=…`).
- `NEW DATA`: **`GET /api/jobs/runs?name=<job>&limit=2`** → `{ runs: { invocation: string, start: number, end: number|null, result: "success"|"failed"|"running", lines: LogEntry[] }[] }`.
  Implementation in `src/collectors/logs.ts` (same journal access as the logs page, §4.8):
  `journalctl --directory=/host/journal -u <name>.service -o json --no-pager -n 5000 -r`, group by
  `_SYSTEMD_INVOCATION_ID`, take the newest 2 groups, return their lines oldest-first. Validate `name` against
  `jobs.jobs[].name` (and the `^keep-[a-z-]+$` pattern). Result comes from the job status for the latest
  run; for the previous run, from a `JOB_RESULT`/exit line if present, else `unknown`.
- External jobs (`dokploy-docker-cleanup`) say why they have no button or logs.
- **Recent actions** gets detail. `NEW DATA` in `host/keep-agent.py` `ActionRecord`: add `requestedBy`
  (the server writes the requester's IP into the request file: `requestAction(dataDir, action, ip)`),
  `startedAt`, `durationSec`, `exitCode`, `output` (last 40 lines, ≤4 KB), `freedBytes?` (tidy). The client
  maps `requestedBy` to a device name with `whoIs()` (exists in `lib/devices.ts`; it needs the
  `/api/activity` devices, so fetch them lazily). The row expands to show output.
- **AI usage moves to sessions** (§4.7).
- Phone: job rows are stacked (name and status / schedule · last · next), the expanded log scrolls
  horizontally inside its box, and the server box comes first (it has the buttons).

### 4.5 Activity `/activity`

Brief: "devices tab nearly empty; long other tab needs better structure (#104)".

```
activity · host log read just now
┌■ now [4]──────────────────────────┐┌■ last 7 days [8]──────────────────────────────────────────────┐
│ ssh                                ││        00  03  06  09  12  15  18  21                          │
│  you · MacBook Pro · lan   3h 53m  ││ Thu   ░░··········▒▒▓▓░░▒▒░░··                                  │ 7×24 day heatmap
│ dokploy                            ││ Fri   ··········░░▒▒▓▓██▓▓░░··                                  │ density=events
│  you@… · MacBook Pro · exp 2d 17h  ││ …                                         click → filter hour   │
│ this dashboard                     ││ [all 412][logins 12][commands 88][deploys 40][system 8] [search]│
│  MacBook Pro · tailscale  ■ live   ││ ─ today ─────────────────────────────────────── sticky header ──│
├────────────────────────────────────┤│ 23:23  deploy   personal / player  manual · ok · 12s       ▸   │
│■ devices · 2 online                ││ 23:07–23:08  2× deploy  personal / player                  ▸   │
│ ■ the-keep  this server  100.64… ⧉ ││ 22:10  sudo     malek  apt upgrade                             │
│ ■ MacBook   macos · direct  now    ││ …  infinite scroll (80 rows per page, IntersectionObserver)     │
│ lan                                ││                                                                 │
│ ■ printer  192.168.1.40 ⧉  …       ││                                                                 │
└────────────────────────────────────┘└────────────────────────────────────────────────────────────────┘
```

- Left [4]: one box "now" (connected: ssh, dokploy, dashboard viewers; each line is a 2-line block so nothing
  wraps mid-value), and below it one box "devices" merging tailnet and LAN as two subsections (IPs and MACs
  copyable, rx/tx in the tooltip). Together they're roughly the timeline's height, so the 70%-empty devices
  box is gone.
- Right [8]: the timeline with a 7×24 heatmap header (from `buildTimeline(data)`, counted per hour). Filter
  chips show counts. Search matches who/what/ref. Day headers are sticky inside the box (`position: sticky;
  top: 0`). The chip column shows the kind only when the filter is `all`. The ref column becomes a copy icon on
  hover (not a full-width column). Folded groups keep `▸`, with the count rendered as a chip.
- Failed logins: a crit chip in the box meta, plus a dedicated filter chip `failed 2` (exists in data:
  `ssh-failed`).
- Phone: tabs at the top of the page, `timeline | now | devices`, with the timeline default (it's the long,
  useful one). The heatmap is 7×24 at 10 px cells (24×12 = 288 px, fits).

### 4.6 Media `/media`

```
media · music and reading
┌■ now playing [8]─────────────────────────────────────────┐┌■ reading · 14 unread · 32 feeds [4]──┐
│ ■ live  1,000,000 · artist · album        you · keep-player│ │ title of post ↗                       │
│        (or: nothing playing · last played …)               │ │ feed · 2h ago                         │
├■ library · navidrome ↗──────────────────────────────────────┤│ …  fills full height (max 20)         │
│ 2,410 tracks  ·  188 albums  ·  64 artists                 │ │                                       │
│ recently added                                             │ │ all caught up / add feeds in miniflux →│
│  The Shade from Our Trees  Josh Woodward       2019   ↗    │ │                                       │
│  … 2-column list on ≥1400px, max 12                        │ │                                       │
│ last import 5m ago: 12 tracks · 3 left in inbox (warn)     │ │                                       │
└──────────────────────────────────────────────────────────┘└───────────────────────────────────────┘
```

- Drop the duplicate songs number: show a fact row `tracks · albums · artists` only.
- Recently added rows link to the album in Navidrome (`NEW DATA`: `recentlyAdded[].id` from Subsonic
  `getAlbumList2` (which already returns `id`), link `${navidrome}/app/#/album/<id>/show`).
- Optional `NEW DATA` to fill the page meaningfully: `frequent` albums (Subsonic `getAlbumList2?type=frequent&size=6`)
  as a "most played" list beside recently added. A listening heatmap is **dropped**: Navidrome exposes no
  per-play history through Subsonic without scrobble storage.
- Reading spans the full height of music, so the two columns end together. Empty state: `no feeds yet · add
  some in miniflux →` centered, and the box shrinks to 160 px with music taking [12] when reading has no feeds.
- Phone: now playing → reading (unread first) → library.

### 4.7 AI sessions `/sessions`

The goal: answer "what did AI cost me, on what, and where's that conversation?"

```
sessions · 1,204 logged · prices from models.dev, updated 2h ago        [7d|30d|90d]
┌$ 7d ───┐┌$ 30d ──┐┌tokens 30d┐┌cache hit┐┌sessions┐┌claude 5h┐┌claude wk┐┌opencode wk┐   tiles
│ $41.20 ││ $163.9 ││ 412.3M   ││ 91%     ││ 214    ││ 38% ▓▓░ ││ 81% ▓▓▓ ││ 22%  ▓░░  │   (limits from aiUsage,
└────────┘└────────┘└──────────┘└─────────┘└────────┘└─────────┘└─────────┘└───────────┘    moved from jobs)
┌■ cost per day · 90 days [8]────────────────────────────┐┌■ by model · 30d [4]────────────────┐
│ Nov ░▒▓█▒░·▒▓▓▒░░▒▓▒▒░▒▓▓█▓▒░ …  (day heatmap, p95)   ││ model        in   out  cache   $   │
│ Mon ▒░·▒▓▓▒░…                                          ││ opus-4-5   1.2M  0.3M  98.1M  92.1 │
│ …                     hover: Tue 18 Nov · $4.21 · 41   ││ sonnet-4-5 …                       │
│ ▂▃▂▅▃▂ cost/day columns (alt view toggle)              ││ unpriced: 1 model → set price      │
└────────────────────────────────────────────────────────┘└────────────────────────────────────┘
┌■ sessions [12]───────────────────────────────────────────────────────────────────────────────────┐
│ [search titles…] [tool: all▾] [machine: all▾] [project: all▾] [model: all▾]     sort:[newest▾]    │
│ when         session                              project    tool    model     tokens    cost     │
│ 11-27 14:03  fix(music): show tracks, keep artist  the-keep   claude  opus-4-5   12.1M   $3.41   │
│              ▁▂▃▅▂ (per-turn tokens, 48px)                                                   ▸   │
│ … infinite scroll, 50 per page                                                                   │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Tokens always include cache.** Show `tokens` = in + out + cacheRead + cacheWrite, and split it in the
  model table. The current `tokensIn + tokensOut` figure is removed everywhere.
- **Cost = computed from stored prices** (below), shown as the primary number. The tool-reported cost shows in
  the tooltip as `reported $3.38`, and a `≠` marker appears when they differ by >5%. Messages with an unpriced
  model count as `—`, and the model table lists them with a "set price" hint.
- Session list: `NEW DATA` `GET /api/sessions?limit=50&offset=&tool=&machine=&dir=&model=&q=&from=&to=`
  (`SessionStore.list` gains WHERE clauses; `q` matches title LIKE; `model` filters on the `models` JSON with
  `json_each`). The facets come from `GET /api/sessions/facets` → distinct tool, machine, project
  (last path segment of `directory`) and model. Rows link to `/sessions?s=<id>`.
- Clicking a heatmap day sets `from/to`. Clicking a model row sets `model`.
- **Detail view**:

```
← sessions   fix(music): show tracks, keep artist                         $3.41 · 12.1M tokens
the-keep · main · claude-code · macbook · 11-27 13:12–14:03 (51m) · 84 messages
[copy: claude pull] [copy: opencode pull] [copy handoff md] [copy id]     ← one chip row, secondary style
┌■ usage [4]─────────────────┐┌■ conversation [8]──────────────────────────────────────────────────┐
│ model     in out cache  $  ││ ▌you · 13:12                                                         │
│ opus-4-5  …                ││  make the music panel show tracks…                                   │
│ tokens per turn            ││ ▌assistant · opus-4-5 · 12.1k in · 0.8k out · $0.04 · 4.2s           │
│ ▂▃▅▂▁▂▃█▂▁ (click → jump)  ││  text…                                                               │
│ tools used                 ││  ▸ Read  src/web/components/home-panels.tsx       ✓                  │
│ Read 31 · Edit 12 · Bash 9 ││  ▸ Bash  bun run typecheck                        ✗ error            │
│                            ││  ▸ thinking (1.2k tokens)                                            │
└────────────────────────────┘└──────────────────────────────────────────────────────────────────────┘
```

  User turns get a 2 px `--fg` left rule, assistant turns none, system turns muted. Tool calls are collapsible
  rows: name, a one-line input summary (`file_path`/`command`/`pattern` key if present, else the JSON
  truncated to 80 chars), status (✓, or ✗ in crit). Expanded: input JSON and output (`<pre>`, max 400 px,
  scroll). Reasoning is collapsed by default. Long text: the first 60 lines, then `show all (n lines)`. The
  usage box is sticky on desktop. On phone the usage box comes first and collapses.

#### Prices: storage and computation (#94, #95)

**models.dev provides what we need.** Checked 2026-11-27: `https://models.dev/api.json` (6.5 MB, 326
providers) has, per `provider.models.<id>.cost`, USD **per million tokens**: `input`, `output`, `cache_read`
(7.3k models), `cache_write` (2.4k models; e.g. OpenAI has none), plus optional `reasoning`,
`context_over_200k` (an object with its own input/output/cache_read) and `tiers` (`[{input, output,
cache_read, tier: {type: "context", size}}]`). Example: `anthropic.claude-sonnet-4-5.cost =
{input: 3, output: 15, cache_read: 0.3, cache_write: 3.75}`.

Storage (in `sessions.db`, new file `src/sessions/prices.ts`):

```sql
CREATE TABLE IF NOT EXISTS model_prices (
  provider TEXT NOT NULL,          -- models.dev provider key: anthropic, openai, azure, openrouter, opencode…
  model TEXT NOT NULL,             -- models.dev model key, e.g. claude-sonnet-4-5
  valid_from INTEGER NOT NULL,     -- ms; a new row only when any price changes
  input REAL NOT NULL, output REAL NOT NULL,
  cache_read REAL, cache_write REAL, reasoning REAL,
  over_200k TEXT,                  -- JSON of context_over_200k / tiers, null if none
  source TEXT NOT NULL,            -- 'models.dev' | 'manual'
  PRIMARY KEY (provider, model, valid_from));
```

- Refresh: on startup and every 24 h, `fetch("https://models.dev/api.json")` server-side (the server has
  internet), keeping only providers seen in sessions plus `anthropic, openai, azure, openrouter, opencode`.
  Insert a row only when the latest row for (provider, model) differs. On fetch failure, keep what's stored.
- Manual overrides: `${DATA_DIR}/prices.json` (`[{provider, model, input, output, cache_read?, cache_write?}]`)
  is loaded as `source='manual'` and wins over models.dev for the same key.
- Model matching for a message (`provider`, `model` from `SessionMessage`): (1) exact `provider/model`;
  (2) normalize: lowercase, strip a `provider/` prefix, strip a date suffix `-\d{8}$`, map `.`→`-`;
  (3) any provider with that model key, preferring `anthropic`/`openai` (first-party) over resellers; (4)
  unpriced. Cache the resolved mapping per distinct (provider, model).
- Cost per message: `(tokensIn·input + tokensOut·output + cacheRead·(cache_read ?? input) + cacheWrite·(cache_write ?? input)) / 1e6`,
  where reasoning tokens are billed at `reasoning ?? output` **only if** the tool reports them separately from
  `tokensOut` (OpenCode does; Claude includes them in output; record this per tool in the parser). If
  `tokensIn + cacheRead + cacheWrite > 200_000` and `over_200k` exists, use those rates. The price used is
  the row with the greatest `valid_from ≤ message.at`.
- Compute at query time in SQL via a temp join, or in TS when building the usage rows. Store nothing derived,
  so a price fix recomputes history. Expose `GET /api/prices` (table plus `updatedAt`) for the "by model"
  panel.
- `usageByDay` gains `cacheRead`, `cacheWrite` and `computedUsd` columns.

### 4.8 Logs `/logs` (new page)

```
logs · journald · 412 MiB / 1 GiB · 14 days kept                         [live ●] [copy link]
┌ filters ─────────────────────────────────────────────────────────────────────────────────────────┐
│ [query (grep, case-insensitive)…            ] [15m|1h|24h|7d|custom] [prio: E W I D] [unit ▾] [boot ▾]│
│ active: unit=keep-tidy.service ×   source=dockerd ×                                    clear all │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
┌■ volume · 1h · 2-min buckets ───────────────────────────────────────────────────────────────────┐
│ ▂▂▃▂▂▂▂▃▅▃▂▂▂▂▃▂▂▂▂▃▂▂▂▂▃▂▂  (errors crit overlay; drag/click to set time range)                │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
┌■ entries · newest first ─────────────────────────────────────────────────────────────────────────┐
│ 11-27 14:03:22.118  E  keep-disk-watch    disk /srv at 76% (warn 75%)                          ⌄ │
│ 11-27 14:03:21.004  I  dockerd           …                                                       │
│ … infinite scroll (older) ↓                                    loading 200 more…                  │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- Filters: query → `--grep`; range → `--since/--until`; priority chips (multi-select maps to the `-p` max
  level; E = 0..3, W = 4, I = 5..6, D = 7, sent as `prio=0..3,4`, using `-p <min>..<max>` per contiguous range,
  or field matches `PRIORITY=n` OR'd); unit → `-u` (a list from `GET /api/logs/units`, which is
  `journalctl --field=_SYSTEMD_UNIT` cached for 5 min); source → `SYSLOG_IDENTIFIER=x`; boot → `-b <id>`
  (list via `--list-boots -o json`). All state lives in the URL query.
- **Container logs are not in journald.** Docker uses the `json-file` driver (`host/etc/docker/daemon.json`,
  3×10 MB). State this in the page's empty/help text, and link each container to Dozzle (`logs.findmalek.engineer`,
  already deployed) as `container logs in dozzle ↗`. Switching Docker to `journald` is out of scope (it
  changes log rotation and disk caps).
- Live: when on, poll every 2 s with `after=<newest cursor>` and prepend. A "n new" pill appears if scrolled
  away from the top.
- Infinite scroll: an IntersectionObserver on the last row fetches `before=<oldest cursor>`. Keep at most 5000
  rows in the DOM, then drop from the far end (windowing isn't needed below that).
- `NEW DATA`: **`GET /api/logs`**
  - params: `q` (≤200 chars), `since`, `until` (ISO or unix s), `prio` (`0-7` list), `unit` (repeatable,
    `^[\w@.-]+\.(service|timer|scope|socket)$`), `source` (repeatable, `^[\w.@-]{1,64}$`), `boot`
    (`^-?\d+$|^[0-9a-f]{32}$`), `before` | `after` (cursor), `limit` (≤500, default 200).
  - response: `{ entries: LogEntry[], before: string|null, after: string|null }` with
    `LogEntry = { cursor: string; at: number /* µs */; priority: number; source: string; unit: string|null; pid: number|null; message: string; fields?: Record<string,string> }`
    (`fields` only with `?fields=1` or on the single-entry endpoint `GET /api/logs/entry?cursor=`).
  - implementation `src/collectors/logs.ts`: `Bun.spawn(["journalctl", "--directory=/host/journal", "-o", "json", "--no-pager", "--output-fields=…", …args])`
    with an argv array (never a shell), a 10 s timeout, and a stdout cap of 5 MB. Paging: newest first uses
    `-r -n limit`; older uses `-r --cursor=<before> -n limit+1` and drops the first entry; newer uses
    `--after-cursor=<after>` (forward, then reverse in JS). **Verify the `-r --cursor` semantics on the host's
    journalctl version**; the fallback is `--until=<oldest at>` plus dedupe by cursor. Non-UTF-8 `MESSAGE`
    arrives as a byte array in JSON: decode with `TextDecoder`.
  - `GET /api/logs/histogram?…same filters…&buckets=60` → counts per bucket plus errors, computed by
    streaming `journalctl -o json --output-fields=PRIORITY` over the range (cap 7 d; for 7 d, read the existing
    `journal.json` hourly summary instead).
- **Container access** (`NEW DATA`, infra): the image is `oven/bun:1.4.2-alpine`, which has no journalctl.
  Switch the `Dockerfile` to `oven/bun:1.4.2-debian` (or `-slim`) and
  `apt-get install -y --no-install-recommends systemd` (for journalctl; we don't run systemd). In compose, mount
  `/var/log/journal:/host/journal:ro` and `/etc/machine-id:/etc/machine-id:ro`. **The container's journalctl
  must be at least as new as the host's systemd**, or it may refuse compact or zstd journal files: check
  `journalctl --version` on the host (Ubuntu 26.04) and pick a base image whose systemd ≥ that (Debian
  trixie ships 257; if the host is newer, build from `ubuntu:26.04` plus the bun binary). This keeps the
  README's rule: the container still runs nothing on the host, it only reads files.
- Nav: `logs` goes under `infra`, after `jobs`. The home system-log box links here, as do job rows.
- Phone: filters collapse into a `filters (2)` button opening a sheet. The query stays visible. Rows use the
  2-line layout (§2.8 log row).

### 4.9 Garage bucket browser `/buckets` (new page; feasible)

- **Feasible**: the Garage admin API (already used) has no object listing, but the S3 API does. `NEW DATA`:
  create a read-only key (`garage key create keep-dashboard-ro`, then `garage bucket allow --read <bucket>
  --key keep-dashboard-ro` per bucket), put `GARAGE_S3_URL`, `GARAGE_S3_KEY` and `GARAGE_S3_SECRET` in
  `integrations.env`, and use Bun's built-in `S3Client` (`list()` with `prefix`/`delimiter`/`startAfter`;
  check that the installed Bun 1.4 has it, and fall back to signing ListObjectsV2 with `aws4fetch`).
- API:
  - `GET /api/buckets/<name>/list?prefix=&after=&limit=200` →
    `{ prefixes: string[], objects: { key, size, modified, etag }[], next: string|null }` (delimiter `/`).
  - `GET /api/buckets/<name>/object?key=` → streams the object with its Content-Type. `?download=1` adds
    `Content-Disposition: attachment`. Inline preview is capped at 25 MB (above it, 413 plus a download link).
    Only the GET method is allowed; no write routes exist.
- UI: a breadcrumb `buckets / photos / 2026 / 11 /`. Left [3] is the bucket list (name, used/quota dither
  meter, object count, from the existing `garage.buckets`). Right [9] is the folder/object table
  (name, size `n-bytes`, modified `n-ago`). Image keys (`.jpg .jpeg .png .webp .gif .avif`) show a 40 px
  thumbnail via `<img loading="lazy" src="/api/buckets/…/object?key=…">`. Clicking a file opens a preview
  pane: image, `<audio>`/`<video>`, PDF in `<iframe>`, or text (first 64 KB in `<pre>`), plus download. Some
  buckets hold encrypted or opaque blobs (Ente stores encrypted files): show `binary · <size>` with no preview
  and no attempt to decode.
- Safety: the key is read-only; the page is behind `KEEP_GATE` like everything else. No delete buttons.
- Phone: the bucket list is a select at the top, the table is stacked rows, and the preview is a full-screen
  sheet.

---

## 5. Brief → spec checklist

| brief item | answer |
|---|---|
| delete 46 GB unused images; builder prune cap 75 GB; delete PR previews on close; DNS via 1.1.1.1; B2 in April | Ops on the host, not design. Tracked outside this spec, **except** the DNS check, which is a dashboard fix (§4.1 sites, step 10). Don't nag about B2: nothing in this spec alerts on offsite backup. |
| storage total includes backup HDD; data disk = /srv only | §4.1 volumes: `MountStats.role`, backup on its own line, excluded from the total. The data disk tile already uses `/srv`. |
| senior bar, desktop and phone, monochrome boxed dithering | §2, §3 |
| reference tokens | §2.2–2.5 (adapted; the warm scale, sky blue and pixel-sky background are dropped, with reasons) |
| GitHub-style day squares with hover counts | §2.8 day heatmap: sessions cost (§4.7), activity (§4.5) |
| home: CPU and RAM twice | §4.1: headlines removed from boxes; tiles are the headline |
| tiles scroll + highlight | §3.4, §2.8 box flash |
| uneven heights / empty space (memory next to network) | §3.2 row-pairing rule; §4.1 pairs cpu|memory with equal graph heights |
| per-core load next to temps, compact squares | §4.1 cpu box heat grid |
| internet: latest speed tests | §4.1 internet table |
| storage: split volumes vs i/o, stop layout shift, long paths | §4.1 volumes + disk i/o, §2.6 fixed widths, path on its own 11 px line |
| IPs copy on click | §2.8 copy value; status bar (desktop), host box (phone) |
| space squares link to apps | §4.1 space heat grid + `UsageItem.url` |
| link everything (drive, music, passwords) | §4.1 space links, §2.8 link affordance, §4.6 album links |
| Garage bucket browser with previews | §4.9 |
| sites clickable, new tab | §4.1 sites, §4.2 |
| system log page with filters, query, infinite scroll | §4.8 |
| containers panel: justify or rethink | §4.1 containers: rethought as "docker's view, problems only" |
| uptime: more dither, range picker (#102) | §4.2, §2.8 uptime strip |
| apps: filters, sort, search, cards, pins, group previews (#103) | §4.3 |
| jobs: how it works, last/previous run logs, action detail | §4.4 |
| activity: devices nearly empty, long tab structure (#104) | §4.5 |
| media: rest of page empty | §4.6 |
| AI sessions: big improvement, stored price table (#94 #95) | §4.7 |

---

## 6. Implementation plan

Each step is one PR, shippable and visible on its own. Steps 1–4 are the foundation; after that, order by
value. Every PR: `bun run typecheck`, plus tests only where a step adds logic (dither level mapping, price
matching, log arg building, uptime bucketing).

1. **Tokens, fonts, no zoom, theme toggle.** Replace the `:root` and light tokens with §2.3; type and spacing
   tokens; remove `html { zoom }` and add the ≥1400 token bump; swap the fonts; delete dead `.grid` areas and
   add `.level-ok`; add the theme toggle.
   Files: `src/web/styles.css`, `src/web/index.html`, `src/web/components/status-bar.tsx`, `src/web/app.tsx`.
2. **Boxes and the page grid.** `.panel` becomes a box (border, card bg, 8 px gap, `height:100%`); header
   36 px; `actions`/`href`/`id`/`flash` props; table `colgroup`/fixed layout; link affordance; chip and status
   restyle; fixed-width number classes; `ms`, `compact` and `usd` move into `format.ts`.
   Files: `components/panel.tsx`, `chip.tsx`, `status-square.tsx`, `lib/format.ts`, `styles.css`; mechanical
   `area`/`id` updates in every `*-panel.tsx`, and `jobs-page.tsx` (its hand-rolled panels move onto `Panel`).
3. **Dither primitives.** `lib/dither.ts` (matrix, `level()`, constants, test), `components/dither.tsx`
   (`DitherDefs`, `dither()`), and a `lib/use-width.ts` ResizeObserver hook. Mount `DitherDefs` in `app.tsx`.
4. **Dither meter, bars, sparkline, heat grid.** Rewrite `meter.tsx` and `sparkline.tsx` (columns, mirrored
   secondary, no viewBox stretching); new `dither-bars.tsx`, `heat-grid.tsx`; swap `journal-panel.tsx` and
   `smart-panel.tsx` bars onto `dither-bars`. Everything else keeps working because the props are unchanged.
5. **Tiles that jump.** `stat-tiles.tsx` (buttons, micro dither chart, fixed height), the scroll+flash logic
   (`lib/jump.ts`), and hash handling on load in `home-page.tsx`.
6. **Copy values and the host box.** `components/copy-value.tsx`; `status-bar.tsx` IPs; a new `host-panel.tsx`
   (phone-only on home).
7. **Home: cpu + temps merge, headlines out, regrid.** `cpu-panel.tsx` (heat grid rows, header meta),
   `memory-panel.tsx` (no `big`, 2×2 legend grid, 96 px graph); delete `sensors-panel.tsx` from home; new
   `.grid.home` areas per §4.1 (desktop, 6-col, phone order) in `styles.css`; `home-page.tsx`.
8. **Storage split and backup.** `types.ts` (`MountStats.role`), `collectors/storage.ts` + `lib/config.ts`
   (`BACKUP_MOUNTS`), a new `volumes-panel.tsx` and `disk-io-panel.tsx` replacing `storage-panel.tsx`, and the
   grid tracks in `styles.css`.
9. **Internet tests table, ad blocking compaction.** `components/home-panels.tsx`; `types.ts`
   `Links.speedtest`; `lib/config.ts`.
10. **Sites box: links, response sparkline, DNS via 1.1.1.1.** `services-panel.tsx`, `collectors/system.ts`
    (`Resolver`), and `home-page.tsx` (adds `kuma:*:ms` keys to the range fetch).
11. **Space heat grid with links + Garage row.** `space-panel.tsx`, `types.ts` (`UsageItem.url?`), the client
    fallback map via `lib/app-status.ts` (`allServices`). The host `keep-usage` script writes `url` (it isn't
    in this repo's `host/`; find it on the box, at `/usr/local/bin/keep-usage`).
12. **Containers box rethink.** `containers-panel.tsx`.
13. **Uptime: strips, range picker, merged columns, phone rows.** `pages/uptime-page.tsx`, new
    `components/uptime-strip.tsx`, `server.ts` (`/api/minutes` limit 2 h → 8 h), `styles.css`.
14. **Apps: cards, filter bar, pins, previews group.** New `components/filter-bar.tsx`, `components/app-card.tsx`;
    `pages/apps-page.tsx`, `lib/router.ts` (query helpers), `cleanup-panel.tsx` (collapsed by default).
15. **Logs API + page.** `Dockerfile` (debian base + systemd), `docker-compose.example.yml` (journal and
    machine-id mounts), new `src/collectors/logs.ts` (argv builder + test), `server.ts` routes (`/logs`,
    `/api/logs`, `/api/logs/units`, `/api/logs/entry`, `/api/logs/histogram`), `types.ts` (`LogEntry`), new
    `pages/logs-page.tsx`, `components/log-row.tsx`, `lib/use-logs.ts`; nav in `app.tsx` and `sidebar.tsx`
    (+ICON); `journal-panel.tsx` links. Deploy note: update the compose on the box.
16. **Job run logs + action detail.** `server.ts` (`/api/jobs/runs`), `collectors/logs.ts`,
    `pages/jobs-page.tsx` (expandable rows, how-it-works strip, server box restyle), `collectors/jobs.ts`
    (`requestAction` passes the requester IP), `host/keep-agent.py` (records `requestedBy`, `startedAt`,
    `durationSec`, `exitCode`, `output`, `freedBytes`), `types.ts` (`ActionRecord`). AI usage leaves this page.
17. **Activity restructure.** `pages/activity-page.tsx`, new `components/day-heatmap.tsx`, `lib/timeline.ts`
    (hour counts, search), `styles.css` (`.grid.activity`, phone tabs).
18. **Media.** `components/home-panels.tsx` (MusicPanel/ReadingPanel), `collectors/home.ts` (album `id`,
    optional `frequent`), `types.ts` (`MusicStats`), `pages/media-page.tsx`, `styles.css`.
19. **Price table + computed cost.** New `src/sessions/prices.ts` (fetch, diff-insert, overrides, matching,
    cost; tests for matching and cost incl. cache and >200k), `sessions/store.ts` (`model_prices` table,
    `usageByDay` columns, filtered `list`, facets), `server.ts` (`/api/prices`, `/api/sessions` params,
    `/api/sessions/facets`, 24 h refresh), `sessions/opencode.ts` + `claude-code.ts` (record whether reasoning
    is separate from output).
20. **Sessions redesign.** `pages/sessions-page.tsx` split into `components/sessions-overview.tsx`,
    `session-list.tsx`, `session-detail.tsx`, `tool-call.tsx`; `lib/use-sessions.ts` (paging, filters);
    `AiUsagePanel` moved here as tiles; `day-heatmap.tsx` reused.
21. **Garage bucket browser.** `integrations.env` keys (box), new `src/collectors/garage-s3.ts`, `server.ts`
    routes, new `pages/buckets-page.tsx`, nav (under `more` on phone), `space-panel.tsx` links.
22. **Phone nav: 5 slots + more sheet.** `components/sidebar.tsx`, new `components/more-sheet.tsx`,
    `styles.css`.
23. **README and screenshots.** Retake `docs/*.png` at 1440 and 390 in both themes; update `README.md`
    (Design section: Geist, dither, warn/crit), plus the new endpoints and mounts.

### 6.1 As built: deviations from the spec

All 23 steps are implemented in one pass, checked against real responses captured from the box (fixture server:
`scripts/dev-fixtures.ts`, which mounts the same `src/routes.ts` API the server does) at 1440×900 and 390×844 in
both themes. Where real data disagreed with the spec, the build follows the data:

- **Home pairs** were re-cut by measured height: cpu [8] | memory [4], network [6] | disk i/o [6] (both mirrored
  in-up/out-down traffic), volumes [6] | disk health [6], internet [6] | ad blocking [6], space [12], sites [12]
  (17 checks, two columns ≥1100 px), containers [5] | system log [7]. Volumes next to disk i/o left a 120 px hole.
- **Heat squares** use `densityLevel()`: zero is the TRACK texture and any non-zero value starts above it, so 1%
  never looks emptier than 0%. Temperatures map 30–95 °C onto density; the warn/crit tone still uses `HEAT`.
- **Hard-limit notch** is a 6×6 solid corner (4×4 vanished at 2 px dots). Space and bucket squares carry their
  used and limit as two text lines; buckets link to `/buckets?b=`.
- **Strips and bars** use uniform cell width and gap, right-aligned (spreading leftover pixels gave 2/4 px gaps
  that read as noise). Response-time sparks scale to p95 (`robust`), so one slow check doesn't flatten the rest.
- **Uptime** buckets fold 5 min / 30 min / 2 h history by averaging known values; the filter is `dipped`
  (up now, below 99.9% over the range) rather than `degraded`.
- **Apps previews**: every Dokploy environment on the box is `production`, so previews are detected by project name
  (`*-previews`, `*-staging`) and service name (`pr-N`, `preview`, `staging`) as well.
- **Logs**: the volume chart reads the journal per request up to 24 h (10 s budget, flagged `cut short` when hit);
  an unfiltered 24 h uses keep-disk-watch's hourly summary instead, and 7 d shows no chart (≈1.2 M lines/day here).
  A priority set with a gap (errors + info) widens `-p` and drops the rest in JS, since `PRIORITY=` matches would
  interact with `-u`. *Show context* opens ±30 s around the entry instead of ±50 lines. On phone the filters wrap
  inline instead of a sheet.
- **Job runs** group by `_SYSTEMD_INVOCATION_ID` (service output) or `INVOCATION_ID` (systemd's own lines), result
  from `JOB_RESULT`. `run:` actions use `systemctl start --no-block`, so their record holds the start's exit code;
  the run's output is on the job row. `tidy` records output and bytes freed.
- **Prices**: `context_over_200k` and models.dev `tiers` are stored together as a `tiers` JSON column (lowest
  threshold first). Whether reasoning tokens are billed apart is a per-tool constant (`opencode` yes, Claude Code
  no) instead of a parser flag. `prices.json` overrides are applied in memory on load, not stored as rows.
  `/api/prices` returns only models seen in sessions. Usage days follow the viewer's clock (`tz` param). Sessions
  per day is the busiest model's count (a session can span models). Titles drop tool markup like `<command-message>`.
- **Activity** heatmap is days × hours (7 × 24), p95-scaled; expired Dokploy sessions are counted, not listed.
- **Media** gained `frequent` albums (Subsonic `type=frequent`) and 12 recent albums / 20 unread articles; now
  playing is its own one-line box above library [8] | reading [4].
- **Buckets**: the preview opens above the listing (full-screen sheet on phone). Text and JSON are served as
  `text/plain`; HTML, SVG and anything else unknown are forced downloads so nothing renders on this origin.
- **Tiles** use `auto-fit` columns, so the sessions page (5 tiles until usage limits are reported) has no hole.

Second pass, after a design review:
- Uptime % uses Kuma's own 24 h and 30 d figures; 7 d averages the stored samples. The strip is one continuous
  FILL-level texture (no gaps); a partial bucket thins to warn dither, so a dip is a change of texture.
- Heat squares: `densityLevel` is the plain 0..16 scale above one step of track; load goes through √ for contrast,
  temperature maps 25–80 °C. Sensors share the core grid on desktop.
- Traffic and disk graphs scale each half to its p95 and label it (`↓ in 100 KB/s`); values under a pixel draw nothing.
- Red and orange only for limits and failures: a clean `exit (0)` and an app asleep on purpose are neutral; error
  counts and the reboot button are plain. One "needs attention" rule (`needsAttention`) drives the nav badge and apps.
- Jobs show `overdue …` for next runs in the past and warn when the agent hasn't reported for 3 minutes.
- Session titles are stripped of markup before they're cut; per-day cost divides by active days; the cost calendar
  appears once there are 14 days of history (until then the bars plus a recent-days table); projects are repos, not
  worktrees (`src/shared/project.ts`, also used by the project filter).
- Buckets answer `Range` with 206 (audio and video stream without the 25 MB cap) and send a CSP `sandbox` on every
  inline response except PDF, which Chrome's viewer can't render sandboxed.

Not done: retaking `docs/*.png` (screenshots stay outside the repo for now; the README still shows the old
overview), the per-turn token spark inside session list rows, drag-to-select on the log volume chart, and the
host-side `keep-usage` url field (the client falls back to the Dokploy service with the item's name).

## Server changes

Nothing below has been applied; the repo side is done.

1. **Image**: the `Dockerfile` now builds on `ubuntu:26.04` (systemd 259, same as the host, so its `journalctl`
   reads the host's journal files) with the bun binary copied from `oven/bun:1.4.2-debian`. Rebuild and redeploy.
2. **Compose for the dashboard** (Dokploy compose `index-optical-capacitor`), add:
   ```yaml
   environment:
     SPEEDTEST_PUBLIC_URL: "https://speed.findmalek.engineer"
     DOZZLE_PUBLIC_URL: "https://logs.findmalek.engineer"
     BACKUP_MOUNTS: "backup"              # the default; matches the existing MOUNTS label
     GARAGE_S3_URL: "http://garage:3900"  # Garage's S3 port on a network the dashboard shares with garage
     GARAGE_S3_KEY: ${GARAGE_S3_KEY}
     GARAGE_S3_SECRET: ${GARAGE_S3_SECRET}
   volumes:
     - /var/log/journal:/host/journal:ro
     - /etc/machine-id:/etc/machine-id:ro
   ```
   The container runs as root, which can read the journal files (`root:systemd-journal 0640`). If the garage
   container isn't on a shared network yet, attach the dashboard to the garage compose's network (read-only use).
3. **Read-only Garage key** for the bucket browser, then put its id and secret in the dashboard's Dokploy env:
   ```sh
   garage key create keep-dashboard-ro
   for b in ceraghit-archive ceraghit-dev dev ente le-hoetel openobserve skiffr-backups trigger-packets turbo-cache; do
     garage bucket allow --read "$b" --key keep-dashboard-ro
   done
   ```
   New buckets need the same `allow --read`. Ente's bucket holds encrypted blobs; the browser lists them and shows
   no preview.
4. **keep-agent**: `install -m 755 host/keep-agent.py /usr/local/bin/keep-agent`. It now records `requestedBy`
   (the IP the server writes into each request), `startedAt`, `durationSec`, `exitCode`, `output` (last 40 lines,
   ≤4 KB) and `freedBytes` for tidy. Unit files are unchanged; it still runs as root from `keep-agent.path`.
5. **keep-usage** (`/usr/local/bin/keep-usage`, not in this repo): add a `"url"` to each item, e.g. photos
   `https://photos.findmalek.engineer`, drive `https://drive.findmalek.engineer`, music
   `https://player.findmalek.engineer`, passwords `https://vault.findmalek.engineer`, dev `/buckets?b=dev`, apps and
   docker `/apps`. Until then the client links each square to the Dokploy service named like the item.
6. **Outbound fetch**: the server fetches `https://models.dev/api.json` (6.5 MB) at start and every 24 h into
   `sessions.db`. The container already has internet; nothing to open.
7. `/api/minutes` now allows 8 h windows (uptime 7 d/30d hover detail). No change needed on the box.
