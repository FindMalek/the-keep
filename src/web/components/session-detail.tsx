import { createContext, Fragment, useContext, useEffect, useRef, useState } from "react";
import type { ConversationSummary, SessionMessage, SubagentSummary, ToolCall } from "../../sessions/types";
import { baseName, cleanTitle, compact, duration, usd } from "../lib/format";
import { navigate } from "../lib/router";
import { stamp } from "../lib/time";
import { useTranscript, type Transcript } from "../lib/use-sessions";
import { DitherBars } from "./dither-bars";
import { PageHeader } from "./page-header";
import { Empty, Panel, Subhead } from "./panel";
import { StatTiles, type Tile } from "./stat-tiles";

const LONG_LINES = 60;
const LONG_CHARS = 1200;
const shortModel = (model: string) => model.replace(/^claude-/, "").replace(/^anthropic\//, "");
const sessionHref = (id: string) => `/sessions?s=${encodeURIComponent(id)}`;

/** "Expand all" bumps `generation`; every tool row and thinking block re-reads `open` when it changes. */
const OpenAll = createContext({ open: false, generation: 0 });

function useOpen(): [boolean, (open: boolean) => void] {
  const all = useContext(OpenAll);
  const [open, setOpen] = useState(all.open);
  useEffect(() => setOpen(all.open), [all.generation]);
  return [open, setOpen];
}

function summaryOf(call: ToolCall): string {
  const input = call.input as Record<string, unknown> | null;
  for (const key of ["description", "file_path", "filePath", "command", "pattern", "path", "url", "query", "prompt"]) {
    const value = input?.[key];
    if (typeof value === "string") return value.replace(/\s+/g, " ");
  }
  const json = JSON.stringify(call.input) ?? "";
  return json.length > 120 ? `${json.slice(0, 120)}…` : json;
}

function Long({ text, className = "turn-text", lines = LONG_LINES, chars = LONG_CHARS }: { text: string; className?: string; lines?: number; chars?: number }) {
  const [all, setAll] = useState(false);
  const split = text.split("\n");
  // Pasted context is often one huge paragraph, so length counts as well as lines.
  const long = split.length > lines || text.length > chars;
  const short = split.slice(0, lines).join("\n").slice(0, chars);
  return (
    <>
      <div className={className}>{all || !long ? text : `${short}…`}</div>
      {long && (
        <button type="button" className="link small more-button" onClick={() => setAll(!all)}>
          {all ? "show less" : `show all (${split.length > lines ? `${split.length} lines` : `${Math.round(text.length / 1000)}k characters`})`}
        </button>
      )}
    </>
  );
}

/** Strings as readable blocks (a command, an edit's old and new text); anything else as JSON. */
function InputView({ input }: { input: unknown }) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return <pre className="tool-pre">{JSON.stringify(input, null, 2)}</pre>;
  const entries = Object.entries(input as Record<string, unknown>);
  const rest = entries.filter(([, value]) => typeof value !== "string");
  return (
    <>
      {entries
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .map(([key, value]) => (
          <Fragment key={key}>
            <Subhead>{key.replace(/_/g, " ")}</Subhead>
            <Long text={value} className={`tool-pre${key === "old_string" ? " is-removed" : key === "new_string" || key === "content" ? " is-added" : ""}`} lines={40} chars={4000} />
          </Fragment>
        ))}
      {rest.length > 0 && <pre className="tool-pre">{JSON.stringify(Object.fromEntries(rest), null, 2)}</pre>}
    </>
  );
}

function ToolRow({ call, run }: { call: ToolCall; run?: SubagentSummary }) {
  const [open, setOpen] = useOpen();
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
          <InputView input={call.input} />
          {call.output !== null && (
            <>
              <Subhead>output</Subhead>
              <Long text={call.output} className="tool-pre" lines={80} chars={8000} />
            </>
          )}
        </div>
      )}
      {run && <SubagentBlock run={run} />}
    </li>
  );
}

/** A subagent run where it was spawned: one line, expanding into its own transcript in place. */
function SubagentBlock({ run }: { run: SubagentSummary }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`subagent${open ? " is-open" : ""}`}>
      <button type="button" className="subagent-line" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="tool-toggle">{open ? "▾" : "▸"}</span>
        <span className="subagent-tag">subagent</span>
        <span className="ellipsis">{cleanTitle(run.title) || run.id.split(":").at(-1)}</span>
        <span className="muted subagent-numbers">
          {run.messageCount} msgs · {compact(run.tokens)} tok{run.costUsd !== null ? ` · ${usd(run.costUsd)}` : ""}
        </span>
      </button>
      {open && (
        <div className="subagent-body">
          <a className="link small" href={sessionHref(run.id)} onClick={navigate}>
            open this run on its own →
          </a>
          <Conversation id={run.id} />
        </div>
      )}
    </div>
  );
}

function Thinking({ message }: { message: SessionMessage }) {
  const [open, setOpen] = useOpen();
  const reasoning = message.reasoning ?? "";
  return (
    <>
      <button type="button" className="tool-line thinking" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="tool-toggle">{open ? "▾" : "▸"}</span>
        <span className="tool-name">thinking</span>
        <span className="muted ellipsis">{open ? (message.tokensReasoning ? `${compact(message.tokensReasoning)} tokens` : `${reasoning.length} chars`) : reasoning.replace(/\s+/g, " ")}</span>
      </button>
      {open && <Long text={reasoning} className="turn-text turn-thinking" />}
    </>
  );
}

function Turn({ message, cost, runs, anchor }: { message: SessionMessage; cost: number | null; runs: Map<string, SubagentSummary>; anchor: boolean }) {
  const prompt = message.tokensIn + message.cacheRead + message.cacheWrite;
  return (
    <li id={anchor ? `m-${message.seq}` : undefined} className={`turn turn-${message.role}`}>
      <div className="turn-meta">
        <span className="turn-role">{message.role === "user" ? "you" : message.role}</span>
        <span>#{message.seq + 1}</span>
        {message.model && <span>{shortModel(message.model)}</span>}
        {message.role === "assistant" && (
          <>
            <span>{compact(prompt)} in</span>
            <span>{compact(message.tokensOut)} out</span>
            {cost !== null && <span>{usd(cost)}</span>}
            {message.latencyMs ? <span>{(message.latencyMs / 1000).toFixed(1)}s</span> : null}
          </>
        )}
        <span className="turn-time" title={message.at ? new Date(message.at).toLocaleString() : undefined}>
          {message.at ? new Date(message.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : ""}
        </span>
      </div>
      {message.reasoning && <Thinking message={message} />}
      {message.text.trim() && <Long text={message.text.trim()} />}
      {message.toolCalls.length > 0 && (
        <ul className="tools">
          {message.toolCalls.map((call, index) => (
            <ToolRow key={index} call={call} run={runs.get(`${message.seq}:${index}`)} />
          ))}
        </ul>
      )}
    </li>
  );
}

function Sentinel({ transcript }: { transcript: Transcript }) {
  const node = useRef<HTMLDivElement>(null);
  const { more, messages, total, loading } = transcript;
  useEffect(() => {
    const element = node.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => entry?.isIntersecting && more(), { rootMargin: "800px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [more, messages.length]);
  const done = messages.length >= total;
  return (
    <div ref={node} className="log-more small muted">
      {done ? (total ? `end · ${total} messages` : "") : loading ? `loading… ${messages.length} of ${total}` : `${messages.length} of ${total} · scroll for more`}
    </div>
  );
}

/** Turns with each run placed at its spawning call; runs whose call is unknown follow the last message before they started. */
function Turns({ transcript, summary, anchor }: { transcript: Transcript; summary: ConversationSummary | undefined; anchor: boolean }) {
  const { messages, costs, total } = transcript;
  const runs = new Map<string, SubagentSummary>();
  const loose = new Map<number, SubagentSummary[]>();
  for (const run of summary?.subagents ?? []) {
    if (run.parentSeq !== null && run.callIndex !== null) {
      runs.set(`${run.parentSeq}:${run.callIndex}`, run);
      continue;
    }
    const after = messages.findLast((m) => m.at <= run.startedAt);
    // The spot is only final once a later message, or the end, is loaded.
    if (after && (after !== messages.at(-1) || messages.length >= total)) loose.set(after.seq, [...(loose.get(after.seq) ?? []), run]);
  }
  return (
    <>
      <ol className="turns">
        {messages.map((message, index) => (
          <Fragment key={message.seq}>
            <Turn message={message} cost={costs[index] ?? null} runs={runs} anchor={anchor} />
            {loose.get(message.seq)?.map((run) => (
              <li key={run.id} className="turn">
                <SubagentBlock run={run} />
              </li>
            ))}
          </Fragment>
        ))}
      </ol>
      <Sentinel transcript={transcript} />
    </>
  );
}

/** A nested run's transcript: the same turns, with its own paging. */
function Conversation({ id }: { id: string }) {
  const transcript = useTranscript(id);
  const head = transcript.head;
  if (head === null) return <p className="small muted">loading…</p>;
  if (head === "missing") return <p className="small muted">this run isn't stored here</p>;
  return <Turns transcript={transcript} summary={head.summary} anchor={false} />;
}

function CommandButton({ title, hint, value, load }: { title: string; hint: string; value?: string; load?: () => Promise<string> }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 1600);
    return () => clearTimeout(timer);
  }, [state]);
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(load ? await load() : (value ?? ""));
      setState("copied");
    } catch {
      setState("failed");
    }
  }
  return (
    <button type="button" className={`command${state === "copied" ? " is-copied" : ""}`} onClick={copy} title={value ?? hint}>
      <span className="command-title">{title}</span>
      <span className="command-glyph" aria-hidden="true">
        {state === "copied" ? "✓ copied" : state === "failed" ? "copy failed" : "⧉ copy"}
      </span>
      <span className="command-hint ellipsis">{value ?? hint}</span>
      <span className="sr-only" aria-live="polite">
        {state === "copied" ? "copied" : ""}
      </span>
    </button>
  );
}

function FilesPanel({ summary }: { summary: ConversationSummary }) {
  const [all, setAll] = useState(false);
  const changed = summary.files.filter((file) => file.edits > 0);
  const shown = all ? summary.files : summary.files.slice(0, 12);
  return (
    <Panel id="files" title="files touched" meta={`${changed.length} changed · ${summary.files.length - changed.length} read`}>
      {summary.files.length === 0 ? (
        <Empty>no file tools used</Empty>
      ) : (
        <ul className="files-touched">
          {shown.map((file) => (
            <li key={file.path} title={file.path}>
              <span className="ellipsis files-path">{file.path}</span>
              <span className={file.edits ? "files-edit" : "muted"}>{file.edits ? `${file.edits} edit${file.edits > 1 ? "s" : ""}` : `${file.reads} read${file.reads > 1 ? "s" : ""}`}</span>
            </li>
          ))}
        </ul>
      )}
      {summary.files.length > 12 && (
        <button type="button" className="link small more-button" onClick={() => setAll(!all)}>
          {all ? "show fewer" : `show all ${summary.files.length}`}
        </button>
      )}
    </Panel>
  );
}

export function SessionDetail({ id }: { id: string }) {
  const transcript = useTranscript(id);
  const [all, setAll] = useState({ open: false, generation: 0 });
  const head = transcript.head;
  const back = (
    <a className="link mono" href="/sessions" onClick={navigate}>
      ← sessions
    </a>
  );
  if (head === null || head === "missing" || !head.summary) {
    return (
      <>
        <PageHeader title="session" meta={head === "missing" ? "not found" : "loading…"}>
          {back}
        </PageHeader>
        <div className="grid">
          <Panel title="session">
            <Empty>{head === "missing" ? "this session isn't stored here" : "loading"}</Empty>
          </Panel>
        </div>
      </>
    );
  }

  const { session, summary, parent } = head;
  const pull = (to: string) => `keep-sessions pull '${session.id}' ${to}`;
  const seconds = Math.max(0, (Math.max(session.endedAt, ...summary.subagents.map((run) => run.endedAt)) - session.startedAt) / 1000);
  const changed = summary.files.filter((file) => file.edits > 0).length;
  const jump = async (seq: number) => {
    await transcript.through(seq);
    requestAnimationFrame(() => document.getElementById(`m-${seq}`)?.scrollIntoView({ block: "start", behavior: "smooth" }));
  };
  const tiles: Tile[] = [
    { key: "cost", label: "cost", value: summary.priced ? usd(summary.costUsd) : "—", sub: session.costUsd !== null ? `tool said ${usd(session.costUsd)}` : "tokens × prices", target: "usage" },
    { key: "tokens", label: "tokens", value: compact(summary.tokens), sub: "in + out + cache", target: "usage" },
    { key: "messages", label: "messages", value: String(summary.messageCount), sub: `${summary.replies.length} replies`, target: "conversation" },
    { key: "runs", label: "subagents", value: String(summary.subagents.length), sub: summary.subagents.length ? "in the totals" : "none", target: summary.subagents.length ? "runs" : "conversation" },
    { key: "files", label: "files changed", value: String(changed), sub: `${summary.files.length - changed} only read`, target: "files" },
    { key: "time", label: "duration", value: duration(seconds), sub: stamp(session.startedAt), target: "conversation" },
  ];

  return (
    <OpenAll.Provider value={all}>
      <PageHeader title={cleanTitle(session.title) || "session"} meta={`${summary.priced ? usd(summary.costUsd) : "unpriced"} · ${compact(summary.tokens)} tokens`}>
        {back}
      </PageHeader>
      <div className="grid">
        <div className="grid-full session-head-line">
          <p className="small muted">
            {parent && (
              <>
                subagent run of{" "}
                <a className="link" href={sessionHref(parent.id)} onClick={navigate}>
                  {cleanTitle(parent.title) || "its conversation"}
                </a>{" "}
                ·{" "}
              </>
            )}
            {baseName(session.directory)}
            {session.branch && ` · ${session.branch}`} · {session.tool} · {session.machine} · {stamp(session.startedAt)}
          </p>
          <div className="commands" role="group" aria-label="continue this session elsewhere">
            <CommandButton title="open in claude code" hint="paste in a terminal" value={pull("claude")} />
            <CommandButton title="open in opencode" hint="paste in a terminal" value={pull("opencode")} />
            <CommandButton
              title="copy handoff markdown"
              hint="the conversation as markdown, for any assistant"
              load={() => fetch(`/api/session?id=${encodeURIComponent(id)}&as=markdown`).then((r) => r.text())}
            />
            <CommandButton title="copy id" hint={session.id} value={session.id} />
          </div>
        </div>
        <StatTiles tiles={tiles} label="session totals" />
        <div className="column column-4 session-side">
          <Panel id="usage" title="usage" meta={summary.subagents.length ? "subagents included" : `${summary.replies.length} replies`}>
            <table className="table table-compact">
              <colgroup>
                <col />
                <col style={{ width: "7ch" }} />
                <col style={{ width: "7ch" }} />
                <col style={{ width: "7ch" }} />
                <col style={{ width: "8ch" }} />
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
                {summary.models.map((entry) => (
                  <tr key={entry.model}>
                    <td className="ellipsis" title={entry.model}>
                      {shortModel(entry.model)}
                    </td>
                    <td className="num right muted">{compact(entry.tokensIn)}</td>
                    <td className="num right muted">{compact(entry.tokensOut)}</td>
                    <td className="num right muted">{compact(entry.cache)}</td>
                    <td className="num right">{usd(entry.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {summary.replies.length > 1 && (
              <>
                <Subhead>tokens per reply</Subhead>
                <DitherBars
                  values={summary.replies.map((reply) => reply.tokens)}
                  height={48}
                  format={compact}
                  label="tokens per reply; pick one to jump to it"
                  describe={(index) => `reply ${index + 1} · message #${(summary.replies[index]?.seq ?? 0) + 1} · ${compact(summary.replies[index]?.tokens ?? 0)} tokens`}
                  onPick={(index) => void jump(summary.replies[index]?.seq ?? 0)}
                />
              </>
            )}
            <Subhead>tools used</Subhead>
            <p className="small tools-used">
              {summary.tools.slice(0, 14).map((tool) => (
                <span key={tool.name}>
                  {tool.name} <span className="muted">{tool.count}</span>
                </span>
              ))}
              {summary.tools.length > 14 && (
                <span className="muted" title={summary.tools.slice(14).map((tool) => `${tool.name} ${tool.count}`).join(", ")}>
                  +{summary.tools.length - 14} more
                </span>
              )}
              {summary.tools.length === 0 && <span className="muted">none</span>}
            </p>
          </Panel>
          {summary.subagents.length > 0 && (
            <Panel id="runs" title="subagents" meta={`${summary.subagents.length} · pick one to jump to its call`}>
              <ul className="runs">
                {summary.subagents.map((run) => (
                  <li key={run.id}>
                    {run.parentSeq !== null ? (
                      <button type="button" className="runs-title ellipsis" onClick={() => void jump(run.parentSeq ?? 0)} title={run.title ?? undefined}>
                        {cleanTitle(run.title) || run.id.split(":").at(-1)}
                      </button>
                    ) : (
                      <a className="runs-title ellipsis" href={sessionHref(run.id)} onClick={navigate} title={run.title ?? undefined}>
                        {cleanTitle(run.title) || run.id.split(":").at(-1)}
                      </a>
                    )}
                    <span className="muted num right">{compact(run.tokens)}</span>
                    <span className="num right">{run.costUsd === null ? "—" : usd(run.costUsd)}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
          <FilesPanel summary={summary} />
        </div>
        <div className="column column-8">
          <Panel
            id="conversation"
            title="conversation"
            meta={`${summary.messageCount} messages${summary.subagents.length ? ` · ${summary.subagents.length} subagent runs inline` : ""}`}
            actions={
              <button type="button" className="button button-quiet" onClick={() => setAll((current) => ({ open: !current.open, generation: current.generation + 1 }))}>
                {all.open ? "collapse all" : "expand all"}
              </button>
            }
          >
            <Turns transcript={transcript} summary={summary} anchor />
          </Panel>
        </div>
      </div>
    </OpenAll.Provider>
  );
}
