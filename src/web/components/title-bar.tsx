import { useEffect, useState } from "react";
import type { HostInfo } from "../../shared/types";
import type { Connection } from "../lib/use-live-data";
import { duration } from "../lib/format";
import { navigate } from "../lib/router";
import { Sparkline } from "./sparkline";

const CONNECTION_LABEL: Record<Connection, string> = { connecting: "connecting", live: "live", offline: "reconnecting" };

function useClock(): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now.toLocaleTimeString([], { hour12: false });
}

export function TitleBar({ host, connection, cpu }: { host: HostInfo | null; connection: Connection; cpu: number[] }) {
  const clock = useClock();

  return (
    <header className="title-bar">
      <div className="title-left">
        <a className="title-host" href="/" onClick={navigate}>
          {host?.hostname ?? "keep"}
        </a>
        {host && (
          <span className="title-os">
            {host.os.toLowerCase()} · {host.kernel}
          </span>
        )}
      </div>
      <div className="title-right">
        {host && (
          <>
            <span className="title-fact">
              <span className="muted">up</span> <span className="n-ago">{duration(host.uptimeSec)}</span>
            </span>
            <span className="title-fact">
              <span className="muted">procs</span> <span className="num">{host.processes}</span>
            </span>
          </>
        )}
        <span className="num title-fact">{clock}</span>
        <span className="title-cpu" title="cpu, last 2 minutes">
          <Sparkline values={cpu.slice(-120)} capacity={120} stepSec={1} max={1} format={String} height={12} label="cpu" bare />
        </span>
        <span className={`connection connection-${connection}`}>
          <span className="connection-square" aria-hidden="true" />
          {CONNECTION_LABEL[connection]}
        </span>
      </div>
    </header>
  );
}
