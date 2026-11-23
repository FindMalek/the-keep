import { useMemo, useState } from "react";
import type { History, RangeName, Snapshot } from "../../shared/types";
import { ContainersPanel } from "../components/containers-panel";
import { CpuPanel } from "../components/cpu-panel";
import { DnsPanel, InternetPanel } from "../components/home-panels";
import { MemoryPanel } from "../components/memory-panel";
import { NetworkPanel } from "../components/network-panel";
import { PageHeader, Tabs } from "../components/page-header";
import { SensorsPanel } from "../components/sensors-panel";
import { ServicesPanel } from "../components/services-panel";
import { SmartPanel } from "../components/smart-panel";
import { SpacePanel } from "../components/space-panel";
import type { SeriesView } from "../components/sparkline";
import { StatTiles, type Tile } from "../components/stat-tiles";
import { StoragePanel } from "../components/storage-panel";
import { bytes, mbps, percent, rate, temperature } from "../lib/format";
import { HEAT } from "../lib/level";
import { rangeLabel as meta } from "../lib/range-label";
import { useRangeHistory } from "../lib/use-range-history";

const RANGES = ["live", "1h", "24h", "7d", "30d"] as const satisfies readonly RangeName[];
const RANGE_KEY = "keep:range";
const TILE_SECONDS = 120;

function storedRange(): RangeName {
  try {
    const value = localStorage.getItem(RANGE_KEY);
    return (RANGES as readonly (string | null)[]).includes(value) ? (value as RangeName) : "live";
  } catch {
    return "live";
  }
}

interface HomePageProps {
  snapshot: Snapshot;
  history: History;
  historySize: number;
}

/** The box at a glance (tiles), then the machine itself over a chosen time range, then internet, space and sites. */
export function HomePage({ snapshot, history, historySize }: HomePageProps) {
  const [range, setRange] = useState<RangeName>(storedRange);
  // The temperature worth a graph: the cpu package, else the hottest sensor.
  const mainSensor =
    snapshot.sensors.find((sensor) => sensor.group === "cpu" && sensor.label === "package") ??
    [...snapshot.sensors].sort((a, b) => b.tempC - a.tempC)[0];
  const tempKey = mainSensor ? `temp:${mainSensor.group}:${mainSensor.label}` : "temp:none";

  const keys = useMemo(
    () => [
      "cpu",
      "mem",
      ...snapshot.network.flatMap((net) => [`net:${net.name}:rx`, `net:${net.name}:tx`]),
      ...snapshot.disks.flatMap((disk) => [`disk:${disk.name}:read`, `disk:${disk.name}:write`]),
      tempKey,
      "containers",
    ],
    [snapshot.network, snapshot.disks, tempKey],
  );
  const longTerm = useRangeHistory(range, keys);

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
      return {
        values: history[key] ?? [],
        secondary: secondaryKey ? (history[secondaryKey] ?? []) : undefined,
        capacity: historySize,
        stepSec: 1,
      };
    }
    const series = longTerm.series[key];
    const values = series?.avg ?? [];
    // Over long ranges a single-series graph shows its peaks underneath the average.
    const secondary = secondaryKey ? longTerm.series[secondaryKey]?.avg : series?.max;
    return { values, secondary, capacity: values.length || 1, stepSec: longTerm.stepSec };
  }

  const recent = (key: string) => (history[key] ?? []).slice(-TILE_SECONDS);
  const lan = snapshot.network.find((net) => net.label === "lan") ?? snapshot.network[0];
  const data = snapshot.mounts.find((mount) => mount.path === "/srv");
  const hottest = snapshot.sensors.reduce((max, sensor) => Math.max(max, sensor.tempC), 0);
  const sites = snapshot.uptime.monitors;
  const sitesDown = sites.filter((monitor) => monitor.status === 0).length;
  const dns = snapshot.home.dns;
  const speed = snapshot.home.internet.latest;

  const tiles: Tile[] = [
    { label: "cpu", value: percent(snapshot.cpu.usage), sub: `load ${snapshot.cpu.load[0].toFixed(2)}`, ratio: snapshot.cpu.usage, series: recent("cpu"), seriesMax: 1, format: percent },
    {
      label: "memory",
      value: bytes(snapshot.memory.used),
      sub: `of ${bytes(snapshot.memory.total)}`,
      ratio: snapshot.memory.used / (snapshot.memory.total || 1),
      series: recent("mem"),
      seriesMax: 1,
      format: percent,
    },
    { label: "data disk", value: data ? percent(data.used / (data.total || 1)) : "—", sub: data ? `${bytes(data.total - data.used)} free` : "", ratio: data ? data.used / (data.total || 1) : 0 },
    { label: "temperature", value: temperature(hottest), sub: "hottest sensor", ratio: hottest / 100, thresholds: HEAT },
    {
      label: "network ↓",
      value: lan ? rate(lan.rxBps) : "—",
      sub: lan ? `↑ ${rate(lan.txBps)}` : "",
      series: lan ? recent(`net:${lan.name}:rx`) : [],
      format: rate,
    },
    {
      label: "sites",
      value: snapshot.uptime.reachable ? `${sites.length - sitesDown}/${sites.length}` : "—",
      sub: sitesDown ? `${sitesDown} down` : "all up",
      tone: sitesDown ? "crit" : undefined,
      href: "/uptime",
    },
    { label: "ads blocked", value: dns.reachable ? percent(dns.queries ? dns.blocked / dns.queries : 0) : "—", sub: dns.reachable ? `${dns.blocked.toLocaleString()} of ${dns.queries.toLocaleString()}` : "adguard down" },
    { label: "internet ↓", value: speed ? mbps(speed.downBps, 0) : "—", sub: speed ? `↑ ${mbps(speed.upBps, 0)} · ${Math.round(speed.pingMs)} ms` : "no test yet" },
  ];

  return (
    <>
      <PageHeader title="home" meta={meta(range, longTerm)}>
        <Tabs options={RANGES} value={range} onChange={selectRange} label="time range" />
      </PageHeader>
      <div className="grid home">
        <StatTiles tiles={tiles} />
        <CpuPanel cpu={snapshot.cpu} sensors={snapshot.sensors} series={view("cpu")} />
        <MemoryPanel memory={snapshot.memory} series={view("mem")} />
        <NetworkPanel network={snapshot.network} view={view} />
        <InternetPanel internet={snapshot.home.internet} />
        <DnsPanel dns={snapshot.home.dns} />
        <StoragePanel mounts={snapshot.mounts} disks={snapshot.disks} view={view} />
        <SmartPanel smart={snapshot.smart} />
        <SensorsPanel sensors={snapshot.sensors} series={range === "live" ? undefined : view(tempKey)} />
        <SpacePanel garage={snapshot.garage} usage={snapshot.usage} mounts={snapshot.mounts} />
        <ServicesPanel services={snapshot.services} uptime={snapshot.uptime} host={snapshot.host} />
        <ContainersPanel containers={snapshot.containers} series={range === "live" ? undefined : view("containers")} />
      </div>
    </>
  );
}
