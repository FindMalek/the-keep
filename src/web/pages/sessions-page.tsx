import { useMemo, useState } from "react";
import type { SessionRow } from "../../sessions/store";
import { Chip } from "../components/chip";
import { PageHeader } from "../components/page-header";
import { Panel } from "../components/panel";
import { navigate } from "../lib/router";
import { stamp } from "../lib/time";
import { useSession, useSessions } from "../lib/use-sessions";

const compact = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const usd = (n: number | null): string => (n === null ? "—" : n > 0 && n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);
const short = (id: string): string => id.split(":").pop()!.slice(0, 8);

function CopyButton({ label, text, load }: { label: string; text?: string; load?: () => Promise<string> }) {
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text ?? (await load!()));
      setState("copied");
    } catch {
      setState("error");
    }
    setTimeout(() => setState("idle"), 2000);
  };
  return (
    <button type="button" className="button" onClick={copy}>
      {state === "copied" ? "copied" : state === "error" ? "failed" : label}
    </button>
  );
}

function Detail({ id }: { id: string }) {
  const data = useSession(id);
  const pullCommand = (to: string) => `keep-sessions pull '${id}' ${to}`;
  if (!data) {
    return (
      <Panel title="session" area="list">
        <span className="muted">loading</span>
      </Panel>
    );
  }
  const { session: s, messages } = data;
  return (
    <>
      <Panel title={s.title ?? short(s.id)} area="usage" meta={`${s.tool} · ${s.machine} · ${stamp(s.startedAt)}`}>
        <div className="session-actions">
          <CopyButton label="copy claude command" text={pullCommand("claude")} />
          <CopyButton label="copy opencode command" text={pullCommand("opencode")} />
          <CopyButton label="copy handoff" load={() => fetch(`/api/session?id=${encodeURIComponent(id)}&as=markdown`).then((r) => r.text())} />
          <a className="button" href="/sessions" onClick={navigate}>
            back
          </a>
        </div>
        <p className="muted">
          {s.directory ?? ""} {s.branch ? `· ${s.branch}` : ""} · {messages.length} messages · {usd(s.costUsd)}
        </p>
      </Panel>
      <Panel title="conversation" area="list">
        <ol className="session-messages">
          {messages.map((m) => (
            <li key={m.seq} className="session-message">
              <div className="session-meta muted">
                <span>{m.role}</span>
                {m.model && <span>{m.model}</span>}
                {m.role === "assistant" && (
                  <span className="num">
                    {compact(m.tokensIn + m.cacheRead)} in · {compact(m.tokensOut)} out{m.costUsd ? ` · ${usd(m.costUsd)}` : ""}
                    {m.latencyMs ? ` · ${(m.latencyMs / 1000).toFixed(1)}s` : ""}
                  </span>
                )}
              </div>
              {m.text && <pre className="session-text">{m.text.length > 4000 ? `${m.text.slice(0, 4000)}…` : m.text}</pre>}
              {m.toolCalls.map((c, i) => (
                <Chip key={i}>{c.name}</Chip>
              ))}
            </li>
          ))}
        </ol>
      </Panel>
    </>
  );
}

function List({ sessions }: { sessions: SessionRow[] }) {
  return (
    <Panel title="sessions" area="list" meta={`${sessions.length} newest`}>
      <table className="table">
        <thead>
          <tr>
            <th>when</th>
            <th>session</th>
            <th className="hide-narrow">tool</th>
            <th className="hide-narrow">machine</th>
            <th className="right hide-narrow">msgs</th>
            <th className="right">tokens</th>
            <th className="right">cost</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => (
            <tr key={s.id}>
              <td className="num muted">{stamp(s.startedAt)}</td>
              <td className="wrap">
                <a href={`/sessions?s=${encodeURIComponent(s.id)}`} onClick={navigate}>
                  {s.title ?? short(s.id)}
                </a>
                {s.directory && <span className="muted"> {s.directory.split("/").slice(-1)[0]}</span>}
              </td>
              <td className="hide-narrow">{s.tool}</td>
              <td className="hide-narrow muted">{s.machine}</td>
              <td className="num right hide-narrow">{s.messageCount}</td>
              <td className="num right">{compact(s.tokensIn + s.tokensOut)}</td>
              <td className="num right">{usd(s.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

export function SessionsPage() {
  const data = useSessions();
  const selected = new URLSearchParams(window.location.search).get("s");
  const totals = useMemo(() => {
    const out = { tokensIn: 0, tokensOut: 0, cost: 0, byModel: new Map<string, number>() };
    for (const s of data?.sessions ?? []) {
      out.cost += s.costUsd ?? 0;
      for (const m of s.models) {
        out.tokensIn += m.tokensIn;
        out.tokensOut += m.tokensOut;
        out.byModel.set(m.model, (out.byModel.get(m.model) ?? 0) + m.tokensIn + m.tokensOut);
      }
    }
    return out;
  }, [data]);

  return (
    <>
      <PageHeader title="sessions" meta={data ? `${data.sessions.length} logged` : "loading"} />
      <div className="grid sessions">
        {selected ? (
          <Detail id={selected} />
        ) : data ? (
          <>
            <Panel title="newest 200 sessions" area="usage" meta="tokens and cost per session">
              <p className="num">
                {compact(totals.tokensIn)} in · {compact(totals.tokensOut)} out · {usd(totals.cost)}
              </p>
              <p className="muted">
                {[...totals.byModel]
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 5)
                  .map(([model, tokens]) => `${model} ${compact(tokens)}`)
                  .join(" · ")}
              </p>
            </Panel>
            <List sessions={data.sessions} />
          </>
        ) : null}
      </div>
    </>
  );
}
