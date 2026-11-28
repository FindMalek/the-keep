import type { BackupStatus, CpuStats, DiskStats, HostInfo, MemoryStats, MountStats, NetStats, SensorReading, SmartDisk, SmartStats } from "../../shared/types";
import { bytes, duration, percent, rate, temperature } from "../lib/format";
import { HEAT, levelClass, levelOf, USAGE, type Thresholds } from "../lib/level";
import { since } from "../lib/time";
import { CopyValue } from "./copy-value";
import { DitherBars } from "./dither-bars";
import { HeatCell } from "./heat";
import { Meter } from "./meter";
import { BoxFoot, Empty, Panel, Subhead } from "./panel";
import { Sparkline, type SeriesView } from "./sparkline";
import { StatusSquare } from "./status-square";

type View = (key: string, secondaryKey?: string) => SeriesView;

const toneOf = (ratio: number, thresholds: Thresholds = USAGE) => {
  const level = levelOf(ratio, thresholds);
  return level === "normal" ? "ink" : level;
};

/** Temperatures on a 25–80 °C scale: the range this box actually lives in, so 33° and 38° look different. */
export const heat01 = (celsius: number) => Math.max(0, Math.min(1, (celsius - 25) / 55));
/** Load is mostly low; a square root spreads 5–30% across more of the density scale. */
const load01 = (ratio: number) => Math.sqrt(Math.max(0, ratio));

interface Column {
  label: string;
  load: number | null;
  temp: number | null;
  title: string;
}

function HeatColumns({ columns, cell, head = "core" }: { columns: Column[]; cell: number; head?: string }) {
  const hasLoad = columns.some((column) => column.load !== null);
  return (
    <div className="cores-grid" style={{ gridTemplateColumns: `40px repeat(${columns.length}, minmax(${cell + 4}px, ${cell + 32}px))` }}>
      <span className="cores-row is-head">{head}</span>
      {columns.map((column, index) => (
        <span key={index} className="heat-label" title={column.title}>
          {column.label}
        </span>
      ))}
      {hasLoad && <span className="cores-row">load</span>}
      {hasLoad && columns.map((column, index) =>
        column.load === null ? (
          <span key={index} />
        ) : (
          <HeatCell key={index} size={cell} value={load01(column.load)} text={percent(column.load)} tone={toneOf(column.load)} title={`${column.title} · ${percent(column.load)}`} />
        ),
      )}
      <span className="cores-row" id="temps">
        temp
      </span>
      {columns.map((column, index) =>
        column.temp === null ? (
          <span key={index} className="heat-text muted">
            —
          </span>
        ) : (
          <HeatCell key={index} size={cell} value={heat01(column.temp)} text={temperature(column.temp)} tone={toneOf(column.temp / 100, HEAT)} title={`${column.title} · ${column.temp} °C`} />
        ),
      )}
    </div>
  );
}

export function CpuPanel({ cpu, sensors, series }: { cpu: CpuStats; sensors: SensorReading[]; series: SeriesView }) {
  const coreTemps = new Map<number, number>();
  for (const sensor of sensors) {
    const match = sensor.group === "cpu" ? /^core (\d+)$/.exec(sensor.label) : null;
    if (match) coreTemps.set(Number(match[1]), sensor.tempC);
  }
  // With hyperthreads there are twice as many load columns as core sensors: core i's temperature sits under load 2i.
  const perTemp = coreTemps.size && cpu.cores.length > coreTemps.size ? Math.round(cpu.cores.length / coreTemps.size) : 1;
  const cores: Column[] = cpu.cores.map((usage, index) => ({
    label: `c${index}`,
    load: usage,
    temp: index % perTemp === 0 ? (coreTemps.get(index / perTemp) ?? null) : null,
    title: `core ${index}`,
  }));
  const short = (label: string) => label.replace("package", "pkg").replace("dimm ", "dimm");
  const others: Column[] = sensors
    .filter((sensor) => !(sensor.group === "cpu" && /^core \d+$/.test(sensor.label)))
    .sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label))
    .map((sensor) => ({ label: short(sensor.label), load: null, temp: sensor.tempC, title: `${sensor.group} · ${sensor.label}` }));
  const meta = [
    cpu.model.toLowerCase().replace(/^intel core |^amd /, ""),
    `${cpu.cores.length} cores`,
    cpu.freqMhz === null ? null : `${(cpu.freqMhz / 1000).toFixed(2)} GHz`,
    `load ${cpu.load.map((value) => value.toFixed(2)).join(" ")}`,
  ].filter(Boolean);

  return (
    <Panel id="cpu" title="cpu" span={8} meta={meta.join(" · ")}>
      <Sparkline {...series} max={1} format={percent} height={96} label="cpu usage" />
      <div className="cores only-wide">
        <HeatColumns columns={[...cores, ...others]} cell={28} />
      </div>
      <div className="cores only-narrow">
        <HeatColumns columns={cores} cell={24} />
        {others.length > 0 && <HeatColumns columns={others} cell={24} head="sensor" />}
      </div>
    </Panel>
  );
}

export function MemoryPanel({ memory, series }: { memory: MemoryStats; series: SeriesView }) {
  const total = memory.total || 1;
  const cached = Math.min(memory.cached, memory.total - memory.used);
  const free = Math.max(0, memory.total - memory.used - cached);
  const ratio = memory.used / total;
  const swap = memory.swapTotal ? memory.swapUsed / memory.swapTotal : 0;

  return (
    <Panel id="memory" title="memory" span={4} meta={`${bytes(memory.total)} · ${bytes(memory.available)} available`}>
      <Meter
        label="memory"
        height={12}
        value={[
          { value: ratio, tone: "strong" },
          { value: cached / total, tone: "dim" },
        ]}
      />
      <dl className="legend legend-3">
        <div>
          <dt>
            <span className="swatch swatch-fill" />
            used
          </dt>
          <dd className={`n-bytes ${levelClass(ratio)}`}>{bytes(memory.used)}</dd>
        </div>
        <div>
          <dt>
            <span className="swatch swatch-dim" />
            cache
          </dt>
          <dd className="n-bytes">{bytes(cached)}</dd>
        </div>
        <div>
          <dt>
            <span className="swatch swatch-track" />
            free
          </dt>
          <dd className="n-bytes">{bytes(free)}</dd>
        </div>
      </dl>
      {memory.swapTotal > 0 && (
        <div className="meter-row" title={`swap ${bytes(memory.swapUsed)} of ${bytes(memory.swapTotal)}`}>
          <span className="muted">swap</span>
          <Meter value={swap} label="swap used" />
          <span className="n-pct">{percent(swap)}</span>
        </div>
      )}
      <Sparkline {...series} max={1} format={percent} label="memory usage" height={96} fill />
    </Panel>
  );
}

function linkSpeed(mbps: number | null): string {
  if (mbps === null) return "virtual";
  return mbps >= 1000 ? `${mbps / 1000} Gb/s` : `${mbps} Mb/s`;
}

export function NetworkPanel({ network, view }: { network: NetStats[]; view: View }) {
  return (
    <Panel id="network" title="network" span={6} meta="↓ in up · ↑ out down">
      {network.map((net) => (
        <div className="stack" key={net.name}>
          <div className="line">
            <span>
              {net.label} <span className="muted">{net.name} · {linkSpeed(net.speedMbps)}</span>
            </span>
            <span className="rates">
              <span className="n-rate">↓ {rate(net.rxBps)}</span>
              <span className="n-rate muted">↑ {rate(net.txBps)}</span>
            </span>
          </div>
          <Sparkline {...view(`net:${net.name}:rx`, `net:${net.name}:tx`)} format={rate} minTop={10_000} height={64} label={`${net.label} traffic`} mirror={["↓ in", "↑ out"]} robust />
          <div className="line small muted">
            <span>since boot</span>
            <span className="rates">
              <span className="n-bytes">↓ {bytes(net.rxTotal)}</span>
              <span className="n-bytes">↑ {bytes(net.txTotal)}</span>
            </span>
          </div>
        </div>
      ))}
    </Panel>
  );
}

export function DiskIoPanel({ disks, view }: { disks: DiskStats[]; view: View }) {
  const busiest = Math.max(0, ...disks.map((disk) => disk.busy));
  return (
    <Panel id="disk-io" title="disk i/o" span={6} meta={`${disks.length} disks · busiest ${percent(busiest)}`}>
      {disks.map((disk) => (
        <div className="stack" key={disk.name}>
          <div className="line">
            <span className="ellipsis">
              {disk.name} <span className="muted">{(disk.model ?? "disk").toLowerCase()} · {bytes(disk.sizeBytes)} · {disk.mounts.filter((path) => !path.startsWith("/boot")).join(" ") || "—"}</span>
            </span>
            <span className={`n-temp ${disk.tempC === null ? "muted" : levelClass(disk.tempC / 100, HEAT)}`} title={disk.tempC === null ? "this disk reports no temperature" : undefined}>
              {disk.tempC === null ? "n/a" : temperature(disk.tempC)}
            </span>
          </div>
          <div className="io-grid">
            <span>
              <span className="muted">r</span> <span className="n-rate">{rate(disk.readBps)}</span>
            </span>
            <span>
              <span className="muted">w</span> <span className="n-rate">{rate(disk.writeBps)}</span>
            </span>
            <span>
              <span className="n-count">{Math.round(disk.readIops + disk.writeIops)}</span> <span className="muted">iops</span>
            </span>
            <span>
              <span className="muted">busy</span> <span className={`n-pct ${levelClass(disk.busy)}`}>{percent(disk.busy)}</span>
            </span>
          </div>
          <Sparkline {...view(`disk:${disk.name}:read`, `disk:${disk.name}:write`)} format={rate} minTop={10_000} height={48} label={`${disk.name} read and write`} mirror={["r", "w"]} robust />
        </div>
      ))}
    </Panel>
  );
}

function VolumeRow({ mount, name }: { mount: MountStats; name?: string }) {
  const ratio = mount.total ? mount.used / mount.total : 0;
  return (
    <li className="volume">
      <span className="volume-name">
        <span>{name ?? mount.label}</span>
        <span className="volume-path">{mount.path}</span>
      </span>
      <Meter value={ratio} label={`${mount.label} used`} ticks />
      <span className="volume-size">
        <span className="n-bytes">{bytes(mount.used)}</span>
        <span className="muted"> / </span>
        <span className="n-bytes muted">{bytes(mount.total)}</span>
      </span>
      <span className={`n-pct ${levelClass(ratio)}`}>{percent(ratio)}</span>
    </li>
  );
}

export function VolumesPanel({ mounts, backup }: { mounts: MountStats[]; backup: BackupStatus | null }) {
  const usable = mounts.filter((mount) => mount.role !== "backup");
  const backups = mounts.filter((mount) => mount.role === "backup");
  const used = usable.reduce((sum, mount) => sum + mount.used, 0);
  const total = usable.reduce((sum, mount) => sum + mount.total, 0);

  return (
    <Panel id="storage" title="volumes" span={6} meta={`${bytes(used)} / ${bytes(total)} usable`}>
      <ul className="list volumes">
        {usable.map((mount) => (
          <VolumeRow key={mount.path} mount={mount} />
        ))}
      </ul>
      {backups.length > 0 && (
        <>
          <Subhead aside="not counted">backup</Subhead>
          <ul className="list volumes">
            {backups.map((mount) => (
              <VolumeRow key={mount.path} mount={mount} name={mount.device ? mount.device.replace("/dev/", "") : "hdd"} />
            ))}
          </ul>
          <p className="small muted box-foot">
            {backup?.at ? (
              <>
                last backup <span className={backup.status === "failed" ? "level-crit" : ""}>{backup.status}</span> {since(Date.parse(backup.at))}
                {backup.sizeBytes !== null && ` · ${bytes(backup.sizeBytes)}`}
              </>
            ) : (
              "no backrest status yet · keep-backrest-status writes it daily at 06:00"
            )}
          </p>
        </>
      )}
    </Panel>
  );
}

const DAYS = 30;

/** GB written per day over the last 30 days, from the daily totals. */
function dailyWrites(disk: SmartDisk): number[] {
  const points = (disk.history ?? []).filter((point) => point.writtenGB !== null).slice(-(DAYS + 1));
  return points.slice(1).map((point, index) => Math.max(0, (point.writtenGB ?? 0) - (points[index]?.writtenGB ?? 0)));
}

export function SmartPanel({ smart }: { smart: SmartStats }) {
  const failing = smart.disks.filter((disk) => disk.health === "failed" || (disk.badSectors ?? 0) > 0).length;
  const unknown = smart.disks.filter((disk) => disk.health === "unknown").length;
  const meta = failing ? <span className="level-crit">{failing} failing</span> : unknown ? <span className="level-warn">{unknown} unknown</span> : `${smart.disks.length} ok`;

  return (
    <Panel id="health" title="disk health" span={6} meta={smart.disks.length ? meta : "not checked"}>
      {smart.disks.length === 0 ? (
        <Empty>smart data not available</Empty>
      ) : (
        smart.disks.map((disk) => {
          const writes = dailyWrites(disk);
          const week = writes.slice(-7);
          const perDay = week.length ? week.reduce((sum, value) => sum + value, 0) / week.length : null;
          const left = disk.wearPercent !== null ? 100 - disk.wearPercent : null;
          const bad = disk.health === "failed" || (disk.badSectors ?? 0) > 0;
          return (
            <div className="stack" key={disk.device}>
              <div className="line">
                <span>
                  <StatusSquare status={bad ? "down" : disk.health === "passed" ? "ok" : "warn"} /> {disk.device.replace("/dev/", "")}{" "}
                  <span className="muted">{disk.kind ?? ""}</span> <span className={bad ? "level-crit" : "muted"}>{disk.badSectors ? `${disk.badSectors} bad sectors` : disk.health}</span>
                </span>
                <span className="facts-inline">
                  <span className={left !== null && left < 80 ? "level-warn" : ""} title="rated endurance left">
                    {left !== null ? `${left}% life` : disk.asleep ? "asleep" : disk.badSectors != null ? `${disk.badSectors} bad sectors` : ""}
                  </span>
                  {disk.writtenGB != null && <span className="muted">{(disk.writtenGB / 1000).toFixed(1)} TB</span>}
                  {perDay !== null && <span className="muted">{Math.round(perDay)} GB/d</span>}
                  <span className="n-temp muted" title={disk.temperatureC == null ? "no temperature reported" : undefined}>
                    {disk.temperatureC == null ? "n/a" : temperature(disk.temperatureC)}
                  </span>
                </span>
              </div>
              {writes.length > 1 && (
                <DitherBars values={writes} height={24} format={(value) => `${Math.round(value)} GB`} label={`${disk.device} GB written per day, last 30 days`} labels={writes.map((_, index) => `${writes.length - index}d ago`)} axis />
              )}
            </div>
          );
        })
      )}
      {smart.at && (
        <BoxFoot>
          checked {since(Date.parse(smart.at))} ·{" "}
          {smart.disks.some((disk) => dailyWrites(disk).length > 1) ? "bars are GB written per day, 30 days" : "daily write bars fill in as history builds (1 day so far)"}
        </BoxFoot>
      )}
    </Panel>
  );
}

/** Phone only: what the desktop status bar carries. */
export function HostPanel({ host }: { host: HostInfo }) {
  const dnsKnown = host.dnsIp !== null && host.publicIp !== null;
  return (
    <Panel id="host" title={host.hostname} span={12} className="only-phone" meta={`up ${duration(host.uptimeSec)} · ${host.kernel}`}>
      <div className="host-ips">
        <CopyValue label="lan" value={host.lanIp} />
        <CopyValue label="tailscale" value={host.tailscaleIp} />
        <CopyValue label="public" value={host.publicIp} />
      </div>
      <p className="small muted">
        <StatusSquare status={!dnsKnown ? "none" : host.dnsIp === host.publicIp ? "ok" : "down"} /> dns {dnsKnown && host.dnsIp === host.publicIp ? "in sync" : `→ ${host.dnsIp ?? "checking"}`}
      </p>
    </Panel>
  );
}
