import { useState } from "react";
import type { SessionMessage, ToolCall } from "../../sessions/types";
import { baseName, cleanTitle, compact, duration, usd } from "../lib/format";
import { navigate } from "../lib/router";
import { stamp } from "../lib/time";
import { useSession } from "../lib/use-sessions";
import { CopyValue } from "./copy-value";
import { DitherBars } from "./dither-bars";
import { PageHeader } from "./page-header";
import { Empty, Panel, Subhead } from "./panel";

const LONG_LINES = 60;
const LONG_CHARS = 1200;

function summaryOf(call: ToolCall): string {
  const input = call.input as Record<string, unknown> | null;
  for (const key of ["file_path", "command", "pattern", "path", "url", "query", "description"]) {
    const value = input?.[key];
    if (typeof value === "string") return value.replace(/\s+/g, " ");
  }
  const json = JSON.stringify(call.input) ?? "";
  return json.length > 80 ? `${json.slice(0, 80)}…` : json;
}

function ToolRow({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  return (
    <li className={`tool${open ? " is-open" : ""}`}>
      <button type="button" className="tool-line" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="tool-toggle">{open ? "▾" : "▸"}</span>
        <span className="tool-name">{call.name}</span>
        <span className="tool-input ellipsis">{summaryOf(call)}</span>
        <span className={call.status === "error" ? "level-crit" : "muted"}>{call.status === "error" ? "✗ error" : call.status === "completed" ? "✓" : ""}</span>
      </button>
      {open && (
        <div className="tool-body">
          <Subhead>input</Subhead>
          <pre>{JSON.stringify(call.input, null, 2)}</pre>
          {call.output !== null && (
            <>
              <Subhead>output</Subhead>
              <pre>{call.output}</pre>
            </>
          )}
        </div>
      )}
    </li>
  );
}

function Text({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  const lines = text.split("\n");
  // Pasted context is often one huge paragraph, so length counts as well as lines.
  const long = lines.length > LONG_LINES || text.length > LONG_CHARS;
  const short = lines.slice(0, LONG_LINES).join("\n").slice(0, LONG_CHARS);
  return (
    <>
      <div className="turn-text">{all || !long ? text : `${short}…`}</div>
      {long && (
        <button type="button" className="link small more-button" onClick={() => setAll(!all)}>
          {all ? "show less" : `show all (${lines.length > LONG_LINES ? `${lines.length} lines` : `${Math.round(text.length / 1000)}k characters`})`}
        </button>
      )}
    </>
  );
}

function Turn({ message, cost }: { message: SessionMessage; cost: number | null }) {
  const [thinking, setThinking] = useState(false);
  const prompt = message.tokensIn + message.cacheRead + message.cacheWrite;
  return (
    <li id={`m-${message.seq}`} className={`turn turn-${message.role}`}>
      <div className="turn-meta">
        <span className="turn-role">{message.role === "user" ? "you" : message.role}</span>
        {message.model && <span>{message.model.replace(/^claude-/, "")}</span>}
        {message.role === "assistant" && (
          <>
            <span>{compact(prompt)} in</span>
            <span>{compact(message.tokensOut)} out</span>
            {cost !== null && <span>{usd(cost)}</span>}
            {message.latencyMs ? <span>{(message.latencyMs / 1000).toFixed(1)}s</span> : null}
          </>
        )}
        <span className="turn-time">{new Date(message.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}</span>
      </div>
      {message.reasoning && (
        <button type="button" className="tool-line thinking" aria-expanded={thinking} onClick={() => setThinking(!thinking)}>
          <span className="tool-toggle">{thinking ? "▾" : "▸"}</span>
          <span className="tool-name">thinking</span>
          <span className="muted">{message.tokensReasoning ? `${compact(message.tokensReasoning)} tokens` : `${message.reasoning.length} chars`}</span>
        </button>
      )}
      {thinking && message.reasoning && <div className="turn-text turn-thinking">{message.reasoning}</div>}
      {message.text && <Text text={message.text} />}
      {message.toolCalls.length > 0 && (
        <ul className="tools">
          {message.toolCalls.map((call, index) => (
            <ToolRow key={index} call={call} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function SessionDetail({ id }: { id: string }) {
  const data = useSession(id);
  const back = (
    <a className="link mono" href="/sessions" onClick={navigate}>
      ← sessions
    </a>
  );
  if (data === null || data === "missing") {
    return (
      <>
        <PageHeader title="session" meta={data === "missing" ? "not found" : "loading…"}>
          {back}
        </PageHeader>
        <div className="grid">
          <Panel title="session">
            <Empty>{data === "missing" ? "this session isn't stored here" : "loading"}</Empty>
          </Panel>
        </div>
      </>
    );
  }

  const { session, messages, costs } = data;
  const total = costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0);
  const priced = costs.some((cost) => cost !== null);
  const assistant = messages.filter((message) => message.role === "assistant");
  const tokens = messages.reduce((sum, message) => sum + message.tokensIn + message.tokensOut + message.cacheRead + message.cacheWrite, 0);
  const models = new Map<string, { tokensIn: number; tokensOut: number; cache: number; usd: number }>();
  messages.forEach((message, index) => {
    if (message.role !== "assistant" || !message.model) return;
    const entry = models.get(message.model) ?? { tokensIn: 0, tokensOut: 0, cache: 0, usd: 0 };
    entry.tokensIn += message.tokensIn;
    entry.tokensOut += message.tokensOut;
    entry.cache += message.cacheRead + message.cacheWrite;
    entry.usd += costs[index] ?? 0;
    models.set(message.model, entry);
  });
  const tools = new Map<string, number>();
  for (const message of messages) for (const call of message.toolCalls) tools.set(call.name, (tools.get(call.name) ?? 0) + 1);
  const pull = (to: string) => `keep-sessions pull '${session.id}' ${to}`;
  const minutes = Math.max(0, (session.endedAt - session.startedAt) / 1000);

  return (
    <>
      <PageHeader title={cleanTitle(session.title) || "session"} meta={`${priced ? usd(total) : "unpriced"} · ${compact(tokens)} tokens`}>
        {back}
      </PageHeader>
      <div className="grid">
        <div className="grid-full session-head-line">
          <p className="small muted">
            {baseName(session.directory)}
            {session.branch && ` · ${session.branch}`} · {session.tool} · {session.machine} · {stamp(session.startedAt)} ({duration(minutes)}) · {messages.length} messages
            {session.costUsd !== null && ` · tool reported ${usd(session.costUsd)}`}
          </p>
          <div className="copy-row">
            <CopyValue label="copy" value={pull("claude")} display="claude pull" />
            <CopyValue label="copy" value={pull("opencode")} display="opencode pull" />
            <CopyValue label="copy" value="handoff" display="handoff md" load={() => fetch(`/api/session?id=${encodeURIComponent(id)}&as=markdown`).then((r) => r.text())} />
            <CopyValue label="copy" value={session.id} display="id" />
          </div>
        </div>
        <div className="column column-4 session-side">
          <Panel title="usage" meta={`${assistant.length} replies`}>
            <table className="table table-compact">
              <colgroup>
                <col />
                <col style={{ width: "8ch" }} />
                <col style={{ width: "8ch" }} />
                <col style={{ width: "8ch" }} />
                <col style={{ width: "9ch" }} />
              </colgroup>
              <thead>
                <tr>
                  <th>model</th>
                  <th className="right">in</th>
                  <th className="right">out</th>
                  <th className="right">cache</th>
                  <th className="right">cost</th>
                </tr>
              </thead>
              <tbody>
                {[...models].map(([model, entry]) => (
                  <tr key={model}>
                    <td className="ellipsis">{model.replace(/^claude-/, "")}</td>
                    <td className="num right muted">{compact(entry.tokensIn)}</td>
                    <td className="num right muted">{compact(entry.tokensOut)}</td>
                    <td className="num right muted">{compact(entry.cache)}</td>
                    <td className="num right">{usd(entry.usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Subhead>tokens per reply</Subhead>
            <DitherBars
              values={assistant.map((message) => message.tokensIn + message.tokensOut + message.cacheRead + message.cacheWrite)}
              height={48}
              format={compact}
              label="tokens per reply; pick one to jump to it"
              describe={(index) => {
                const message = assistant[index];
                return message ? `reply ${index + 1} · ${compact(message.tokensIn + message.tokensOut + message.cacheRead + message.cacheWrite)} tokens` : "";
              }}
              onPick={(index) => document.getElementById(`m-${assistant[index]?.seq}`)?.scrollIntoView({ block: "start", behavior: "smooth" })}
            />
            <Subhead>tools used</Subhead>
            <p className="small tools-used">
              {[...tools]
                .sort((a, b) => b[1] - a[1])
                .map(([name, count]) => (
                  <span key={name}>
                    {name} <span className="muted">{count}</span>
                  </span>
                ))}
              {tools.size === 0 && <span className="muted">none</span>}
            </p>
          </Panel>
        </div>
        <div className="column column-8">
          <Panel title="conversation" meta={`${messages.length} messages`}>
            <ol className="turns">
              {messages.map((message, index) => (
                <Turn key={message.seq} message={message} cost={costs[index] ?? null} />
              ))}
            </ol>
          </Panel>
        </div>
      </div>
    </>
  );
}
