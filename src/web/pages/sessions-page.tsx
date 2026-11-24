import { useMemo, useState } from "react";
import type { SessionRow } from "../../sessions/store";
import { PageHeader } from "../components/page-header";
import { Panel } from "../components/panel";
import { navigate, useSearch } from "../lib/router";
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
      <Panel title={s.title ?? short(s.id)} area="usage" meta={`${s.tool} · ${s.machine} · ${s.startedAt ? stamp(s.startedAt) : "unknown time"}`}>
        <div className="session-actions">
          <CopyButton label="copy claude command" text={pullCommand("claude")} />
          <CopyButton label="copy opencode command" text={pullCommand("opencode")} />
          <CopyButton label="copy handoff" load={() => fetch(`/api/session?id=${encodeURIComponent(id)}&as=markdown`).then((r) => r.text())} />
          <a className="button" href="/sessions" onClick={navigate}>
            back
          </a>
        </div>
        <p className="muted">
          {s.repository ?? "no repository"} {s.directory ? `· ${s.directory}` : ""} {s.branch ? `· ${s.branch}` : ""} · {messages.length} messages · {usd(s.costUsd)}
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
              {m.text.length > 4000 && <details className="session-tool"><summary>show full message</summary><pre className="session-text">{m.text}</pre></details>}
              {m.reasoning && <details className="session-tool"><summary>reasoning</summary><pre className="session-text">{m.reasoning}</pre></details>}
              {m.toolCalls.map((c, i) => (
                <details className="session-tool" key={i}>
                  <summary>{c.name} · {c.status}</summary>
                  {c.input != null && <pre className="session-text">{JSON.stringify(c.input, null, 2)}</pre>}
                  {c.output && <pre className="session-text">{c.output}</pre>}
                </details>
              ))}
            </li>
          ))}
        </ol>
      </Panel>
    </>
  );
}

function List({ sessions, repositories, repository, offset, total, onRepository, onOffset }: {
  sessions: SessionRow[]; repositories: string[]; repository: string | null; offset: number; total: number;
  onRepository: (repository: string | null) => void; onOffset: (offset: number) => void;
}) {
  return (
    <Panel title="sessions" area="list" meta={total ? `${offset + 1}–${offset + sessions.length} of ${total}` : "0 sessions"}>
      <label className="session-filter">repository <select value={repository === null ? "all" : repository === "" ? "unassigned" : `repo:${repository}`} onChange={(event) => {
        const value = event.target.value;
        onRepository(value === "all" ? null : value === "unassigned" ? "" : value.slice(5));
      }}><option value="all">all repositories</option><option value="unassigned">no repository</option>{repositories.map((name) => <option key={name} value={`repo:${name}`}>{name}</option>)}</select></label>
      {sessions.length === 0 ? <p className="empty">{repository === null ? "no sessions received yet · sessions must be ingested and pushed from each machine" : "no sessions for this repository"}</p> : (
      <table className="table">
        <thead>
          <tr>
            <th>when</th>
            <th>session</th>
            <th className="hide-narrow">repository</th>
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
              <td className="num muted">{s.startedAt ? stamp(s.startedAt) : "—"}</td>
              <td className="wrap">
                <a href={`/sessions?s=${encodeURIComponent(s.id)}`} onClick={navigate}>
                  {s.title ?? short(s.id)}
                </a>
              </td>
              <td className="hide-narrow muted">{s.repository ?? "—"}</td>
              <td className="hide-narrow">{s.tool}</td>
              <td className="hide-narrow muted">{s.machine}</td>
              <td className="num right hide-narrow">{s.messageCount}</td>
              <td className="num right">{compact(s.tokensIn + s.tokensOut)}</td>
              <td className="num right">{usd(s.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      )}
      {total > 200 && <div className="session-actions"><button className="button" type="button" disabled={offset === 0} onClick={() => onOffset(Math.max(0, offset - 200))}>newer</button><button className="button" type="button" disabled={offset + sessions.length >= total} onClick={() => onOffset(offset + 200)}>older</button></div>}
    </Panel>
  );
}

export function SessionsPage() {
  const [repository, setRepository] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const data = useSessions(repository, offset);
  const selected = new URLSearchParams(useSearch()).get("s");
  const totals = useMemo(() => {
    const out: { tokensIn: number; tokensOut: number; cost: number | null; byModel: Map<string, number> } = { tokensIn: 0, tokensOut: 0, cost: null, byModel: new Map() };
    for (const s of data?.sessions ?? []) {
      if (s.costUsd !== null) out.cost = (out.cost ?? 0) + s.costUsd;
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
      <PageHeader title="sessions" meta={data ? `${data.total} logged` : "loading"} />
      <div className="grid sessions">
        {selected ? (
          <Detail id={selected} />
        ) : data ? (
          <>
            {data.sessions.length > 0 && <Panel title="sessions on this page" area="usage" meta="tokens and cost per session">
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
            </Panel>}
            <List sessions={data.sessions} repositories={data.repositories} repository={repository} offset={offset} total={data.total} onRepository={(next) => { setRepository(next); setOffset(0); }} onOffset={setOffset} />
          </>
        ) : null}
      </div>
    </>
  );
}
