import { useEffect, useMemo, useRef, useState } from "react";
import type { History, RangeName, Snapshot } from "../../shared/types";
import { ContainersPanel, DnsPanel, InternetPanel, isSite, JournalPanel, SitesPanel, SpacePanel } from "../components/home-panels";
import { PageHeader, Tabs } from "../components/page-header";
import type { SeriesView } from "../components/sparkline";
import { StatTiles, type Tile } from "../components/stat-tiles";
import { CpuPanel, DiskIoPanel, heat01, HostPanel, MemoryPanel, NetworkPanel, SmartPanel, VolumesPanel } from "../components/system-panels";
import { bytes, compact, mbps, percent, rate, temperature } from "../lib/format";
import { jumpTo } from "../lib/jump";
import { QUOTA } from "../lib/level";
import { rangeLabel as meta } from "../lib/range-label";
import { useRangeHistory } from "../lib/use-range-history";

const RANGES = ["live", "1h", "24h", "7d", "30d"] as const satisfies readonly RangeName[];
const RANGE_KEY = "keep:range";
const TILE_SECONDS = 120;

function storedRange(): RangeName {
  try {
    const value = localStorage.getItem(RANGE_KEY);
    return RANGES.includes(value as RangeName) ? (value as RangeName) : "live";
  } catch {
    return "live";
  }
}

interface HomePageProps {
  snapshot: Snapshot;
  history: History;
  historySize: number;
}

/** Headline tiles, then one box per subsystem, each shown once. */
export function HomePage({ snapshot, history, historySize }: HomePageProps) {
  const [range, setRange] = useState<RangeName>(storedRange);

  const keys = useMemo(
    () => [
      "cpu",
      "mem",
      ...snapshot.network.flatMap((net) => [`net:${net.name}:rx`, `net:${net.name}:tx`]),
      ...snapshot.disks.flatMap((disk) => [`disk:${disk.name}:read`, `disk:${disk.name}:write`]),
    ],
    [snapshot.network, snapshot.disks],
  );
  const longTerm = useRangeHistory(range, keys);
  const siteKeys = useMemo(() => snapshot.uptime.monitors.filter(isSite).map((monitor) => `kuma:${monitor.id}:ms`), [snapshot.uptime.monitors]);
  const siteHistory = useRangeHistory("24h", siteKeys);

  // A deep link (#cpu) jumps once the boxes exist.
  const jumped = useRef(false);
  useEffect(() => {
    if (jumped.current) return;
    jumped.current = true;
    const id = window.location.hash.slice(1);
    if (id) window.setTimeout(() => jumpTo(id), 50);
  }, []);

  function selectRange(next: RangeName): void {
    setRange(next);
    try {
      localStorage.setItem(RANGE_KEY, next);
    } catch {
      // Remembering the range is a convenience only.
    }
  }

  function view(key: string, secondaryKey?: string): SeriesView {
    // Loading another range: an empty graph, not the live one under the wrong label.
    if (range !== "live" && !longTerm) return { values: [], capacity: 1, stepSec: 1 };
    if (range === "live" || !longTerm) {
      return { values: history[key] ?? [], secondary: secondaryKey ? (history[secondaryKey] ?? []) : undefined, capacity: historySize, stepSec: 1 };
    }
    const series = longTerm.series[key];
    const values = series?.avg ?? [];
    // Over long ranges a single-series graph shows its peaks above the average.
    const secondary = secondaryKey ? longTerm.series[secondaryKey]?.avg : series?.max;
    return { values, secondary, capacity: values.length || 1, stepSec: longTerm.stepSec };
  }

  const recent = (key: string) => (history[key] ?? []).slice(-TILE_SECONDS);
  const lan = snapshot.network.find((net) => net.label === "lan") ?? snapshot.network[0];
  const data = snapshot.mounts.find((mount) => mount.path === "/srv");
  const hottestSensor = [...snapshot.sensors].sort((a, b) => b.tempC - a.tempC)[0];
  const sites = snapshot.uptime.monitors.filter(isSite);
  const sitesDown = sites.filter((monitor) => monitor.status === 0).length;
  const dns = snapshot.home.dns;
  const speed = snapshot.home.internet.latest;
  const memRatio = snapshot.memory.used / (snapshot.memory.total || 1);

  const tiles: Tile[] = [
    { key: "cpu", label: "cpu", value: percent(snapshot.cpu.usage), sub: `load ${snapshot.cpu.load[0].toFixed(2)}`, ratio: snapshot.cpu.usage, series: recent("cpu"), seriesMax: 1, target: "cpu" },
    { key: "memory", label: "memory", value: bytes(snapshot.memory.used), sub: `of ${bytes(snapshot.memory.total)} · ${percent(memRatio)}`, ratio: memRatio, series: recent("mem"), seriesMax: 1, target: "memory" },
    {
      key: "disk",
      label: "data disk",
      value: data ? percent(data.used / (data.total || 1)) : "—",
      sub: data ? `${bytes(data.total - data.used)} free` : "",
      ratio: data ? data.used / (data.total || 1) : 0,
      thresholds: QUOTA,
      target: "storage",
    },
    {
      key: "temp",
      label: "temperature",
      value: temperature(hottestSensor?.tempC ?? null),
      sub: hottestSensor ? `hottest: ${hottestSensor.label}` : "no sensors",
      // Same 25–80 °C scale as the squares; warn at 70°, crit at 85°.
      ratio: heat01(hottestSensor?.tempC ?? 0),
      thresholds: { warn: heat01(70), crit: heat01(85) - 0.001 },
      target: "temps",
    },
    { key: "net", label: "network ↓", value: lan ? rate(lan.rxBps) : "—", sub: lan ? `↑ ${rate(lan.txBps)}` : "", series: lan ? recent(`net:${lan.name}:rx`) : [], robust: true, target: "network" },
    {
      key: "sites",
      label: "sites",
      value: snapshot.uptime.reachable ? `${sites.length - sitesDown}/${sites.length}` : "—",
      sub: sitesDown ? `${sitesDown} down` : "all up",
      tone: sitesDown ? "crit" : undefined,
      ratio: sites.length ? (sites.length - sitesDown) / sites.length : 0,
      thresholds: { warn: 2, crit: 2 },
      target: "sites",
    },
    {
      key: "ads",
      label: "ads blocked",
      value: dns.reachable ? percent(dns.queries ? dns.blocked / dns.queries : 0) : "—",
      sub: dns.reachable ? `${compact(dns.blocked)} of ${compact(dns.queries)}` : "adguard down",
      series: dns.hourlyBlocked,
      robust: true,
      target: "dns",
    },
    {
      key: "internet",
      label: "internet ↓",
      value: speed ? mbps(speed.downBps, 0) : "—",
      sub: speed ? `↑ ${mbps(speed.upBps, 0)} · ${Math.round(speed.pingMs)} ms` : "no test yet",
      series: snapshot.home.internet.history.map((result) => result.downBps),
      robust: true,
      target: "internet",
    },
  ];

  return (
    <>
      <PageHeader title="home" meta={meta(range, longTerm)}>
        <Tabs options={RANGES} value={range} onChange={selectRange} label="time range" />
      </PageHeader>
      <div className="grid">
        <HostPanel host={snapshot.host} />
        <StatTiles tiles={tiles} />
        <CpuPanel cpu={snapshot.cpu} sensors={snapshot.sensors} series={view("cpu")} />
        <MemoryPanel memory={snapshot.memory} series={view("mem")} />
        <NetworkPanel network={snapshot.network} view={view} />
        <DiskIoPanel disks={snapshot.disks} view={view} />
        <VolumesPanel mounts={snapshot.mounts} backup={snapshot.jobs.backup} />
        <SmartPanel smart={snapshot.smart} />
        <InternetPanel internet={snapshot.home.internet} link={snapshot.links.speedtest ?? null} />
        <DnsPanel dns={snapshot.home.dns} />
        <SpacePanel garage={snapshot.garage} usage={snapshot.usage} mounts={snapshot.mounts} apps={snapshot.apps} />
        <SitesPanel uptime={snapshot.uptime} host={snapshot.host} history={siteHistory} apps={snapshot.apps} />
        <ContainersPanel containers={snapshot.containers} switches={snapshot.jobs.switches} />
        <JournalPanel journal={snapshot.journal} />
      </div>
    </>
  );
}
