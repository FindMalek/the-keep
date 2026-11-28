import { useEffect, useMemo, useState } from "react";
import type { N8nStats } from "../../shared/types";
import { since } from "../lib/time";
import { ActionButton } from "./action-button";
import { Empty, Panel, Subhead } from "./panel";
import { StatusSquare } from "./status-square";

type Workflow = N8nStats["workflows"][number];

const NODE_W = 150;
const NODE_H = 40;

/** n8n's own canvas positions, scaled down; edges are elbows, nodes are boxes. */
function WorkflowGraph({ workflow }: { workflow: Workflow }) {
  const graph = useMemo(() => {
    if (!workflow.nodes.length) return null;
    const minX = Math.min(...workflow.nodes.map((node) => node.x));
    const minY = Math.min(...workflow.nodes.map((node) => node.y));
    const scale = 0.7;
    const nodes = workflow.nodes.map((node) => ({ ...node, left: 8 + (node.x - minX) * scale, top: 8 + (node.y - minY) * scale }));
    const width = Math.max(...nodes.map((node) => node.left)) + NODE_W + 8;
    const height = Math.max(...nodes.map((node) => node.top)) + NODE_H + 8;
    return { nodes, width, height, lookup: new Map(nodes.map((node) => [node.name, node])) };
  }, [workflow]);

  if (!graph) return <Empty>no nodes in this workflow</Empty>;
  return (
    <div className="flow-scroll" aria-label={`${workflow.name} nodes`}>
      <div className="flow" style={{ width: graph.width, height: graph.height }}>
        <svg width={graph.width} height={graph.height} aria-hidden="true">
          {workflow.edges.map((edge, index) => {
            const from = graph.lookup.get(edge.from);
            const to = graph.lookup.get(edge.to);
            if (!from || !to) return null;
            const x1 = from.left + NODE_W;
            const y1 = from.top + NODE_H / 2;
            const x2 = to.left;
            const y2 = to.top + NODE_H / 2;
            const mid = (x1 + x2) / 2;
            return <path key={`${edge.from}-${edge.to}-${index}`} d={`M ${x1} ${y1} H ${mid} V ${y2} H ${x2}`} />;
          })}
        </svg>
        {graph.nodes.map((node) => (
          <div key={node.name} className={`flow-node${node.disabled ? " is-off" : ""}`} style={{ left: node.left, top: node.top, width: NODE_W, height: NODE_H }}>
            <span className="ellipsis">{node.name}</span>
            <span className="muted small ellipsis">{node.disabled ? "disabled" : node.type.split(".").pop()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function useN8n(): N8nStats | null {
  const [data, setData] = useState<N8nStats | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch("/api/n8n");
        if (!response.ok) throw new Error(String(response.status));
        if (!cancelled) setData((await response.json()) as N8nStats);
      } catch {
        if (!cancelled) setData((previous) => previous ?? { status: "unreachable", workflows: [], executions: [], executionsAvailable: false, truncated: false });
      }
    };
    void load();
    const timer = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  return data;
}

const failed = (status: string) => status === "error" || status === "crashed";

export function WorkflowsPanel() {
  const data = useN8n();
  const [selected, setSelected] = useState<string | null>(null);
  const workflows = data?.workflows ?? [];
  const runs = data?.executions ?? [];
  const names = new Map(workflows.map((item) => [item.id, item.name]));
  const workflow = workflows.find((item) => item.id === selected) ?? workflows[0];
  const dayAgo = Date.now() - 86_400_000;
  const failing = new Set(runs.filter((run) => failed(run.status) && Date.parse(run.startedAt ?? "") > dayAgo).map((run) => run.workflowId));
  const lastRun = (id: string) => runs.find((run) => run.workflowId === id);

  const meta = !data ? (
    "loading"
  ) : data.status !== "connected" ? (
    <span className="level-warn">{data.status}</span>
  ) : (
    <>
      {workflows.filter((item) => item.active).length}/{workflows.length} active
      {failing.size ? <span className="level-crit"> · {failing.size} failed today</span> : ""}
    </>
  );

  return (
    <Panel id="workflows" title="n8n workflows" span={8} meta={meta}>
      {!data ? (
        <Empty>loading</Empty>
      ) : data.status === "not configured" ? (
        <Empty>keep-n8n-status hasn't written n8n-status.json yet</Empty>
      ) : data.status === "unreachable" ? (
        <Empty>n8n's database could not be read</Empty>
      ) : workflows.length === 0 ? (
        <Empty>no workflows</Empty>
      ) : (
        <div className="stack">
          <ul className="list" aria-label="workflows">
            {workflows.map((item) => {
              const last = lastRun(item.id);
              return (
                <li key={item.id}>
                  <button type="button" className={`line row-button${item.id === workflow?.id ? " is-current" : ""}`} aria-pressed={item.id === workflow?.id} onClick={() => setSelected(item.id)}>
                    <span>
                      <StatusSquare status={failing.has(item.id) ? "down" : item.active ? "ok" : "warn"} label={failing.has(item.id) ? "a recent run failed" : item.active ? "active" : "inactive"} /> {item.name}
                    </span>
                    <span className="facts-inline muted">
                      <span>{item.nodes.length} nodes</span>
                      <span className="n-ago">{last?.startedAt ? since(Date.parse(last.startedAt)) : "—"}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {workflow && (
            <>
              <Subhead
                aside={
                  workflow.runnable ? (
                    <ActionButton endpoint="/api/n8n/run" action={`run-n8n:${workflow.id}`} label="run now" confirm="tap again to run" danger />
                  ) : (
                    <span className="muted">runs on its own schedule</span>
                  )
                }
              >
                {workflow.name}
              </Subhead>
              <WorkflowGraph workflow={workflow} />
            </>
          )}
          <Subhead aside={data.executionsAvailable ? `last ${runs.length}` : "unavailable"}>recent runs</Subhead>
          {!data.executionsAvailable || runs.length === 0 ? (
            <Empty>no runs recorded</Empty>
          ) : (
            <ul className="list">
              {runs.slice(0, 12).map((run) => (
                <li key={run.id} className="line">
                  <span>
                    <StatusSquare status={failed(run.status) ? "down" : run.status === "success" ? "ok" : "warn"} label={run.status} /> {names.get(run.workflowId) ?? run.workflowId}
                  </span>
                  <span className="facts-inline muted">
                    <span className={failed(run.status) ? "level-crit" : ""}>{run.status}</span>
                    <span>{run.mode}</span>
                    <span className="n-ago">{run.startedAt ? since(Date.parse(run.startedAt)) : "—"}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Panel>
  );
}
