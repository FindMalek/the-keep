import { useEffect, useMemo, useState } from "react";
import type { N8nStats } from "../../shared/types";
import { since } from "../lib/time";
import { Chip } from "./chip";

type Workflow = N8nStats["workflows"][number];

function WorkflowGraph({ workflow }: { workflow: Workflow }) {
  const graph = useMemo(() => {
    if (!workflow.nodes.length) return { nodes: [], width: 220, height: 100 };
    const minX = Math.min(...workflow.nodes.map((node) => node.x));
    const minY = Math.min(...workflow.nodes.map((node) => node.y));
    const maxX = Math.max(...workflow.nodes.map((node) => node.x));
    const maxY = Math.max(...workflow.nodes.map((node) => node.y));
    const sx = Math.min(1, 1800 / (maxX - minX || 1));
    const sy = Math.min(1, 1000 / (maxY - minY || 1));
    const nodes = workflow.nodes.map((node) => ({ ...node, left: 20 + (node.x - minX) * sx, top: 20 + (node.y - minY) * sy }));
    return { nodes, width: 220 + (maxX - minX) * sx, height: 100 + (maxY - minY) * sy };
  }, [workflow]);

  if (!graph.nodes.length) return <p className="empty">no nodes returned by n8n</p>;
  const lookup = new Map(graph.nodes.map((node) => [node.name, node]));
  return (
    <div className="workflow-canvas-scroll" aria-label={`${workflow.name} graph`}>
      <div className="workflow-canvas" style={{ width: graph.width, height: graph.height }}>
        <svg width={graph.width} height={graph.height} aria-hidden="true">
          {workflow.edges.map((edge, index) => {
            const from = lookup.get(edge.from);
            const to = lookup.get(edge.to);
            if (!from || !to) return null;
            const x1 = from.left + 164, y1 = from.top + 28, x2 = to.left, y2 = to.top + 28;
            return <path key={`${edge.from}-${edge.to}-${index}`} d={`M ${x1} ${y1} C ${x1 + 45} ${y1}, ${x2 - 45} ${y2}, ${x2} ${y2}`} />;
          })}
        </svg>
        {graph.nodes.map((node) => <div key={node.name} className={`workflow-node${node.disabled ? " workflow-node-disabled" : ""}`} style={{ left: node.left, top: node.top }}>
          <strong>{node.name}</strong><span>{node.type.split(".").pop()}</span>
        </div>)}
      </div>
    </div>
  );
}

export function WorkflowsPanel() {
  const [data, setData] = useState<N8nStats | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch("/api/n8n");
        if (!response.ok) throw new Error("dashboard request failed");
        if (!cancelled) setData(await response.json() as N8nStats);
      } catch {
        if (!cancelled) setData((previous) => previous ?? { status: "unreachable", workflows: [], executions: [], executionsAvailable: false, truncated: false });
      }
    };
    void load();
    const timer = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const workflow = data?.workflows.find((item) => item.id === selected) ?? data?.workflows[0];
  const names = new Map(data?.workflows.map((item) => [item.id, item.name]));
  return (
    <section className="panel" aria-label="n8n workflows">
      <header className="panel-header"><h2>n8n workflows</h2><span className="panel-meta">{data?.status ?? "loading"}</span></header>
      <div className="panel-body">
        {!data ? <p className="empty">loading workflows</p> : data.status === "not configured" ? (
          <p className="empty">Set N8N_URL and an N8N_API_KEY to connect workflows and execution history.</p>
        ) : data.status === "unreachable" ? (
          <p className="empty">n8n could not be reached or rejected the API key.</p>
        ) : data.workflows.length === 0 ? <p className="empty">no workflows returned by n8n</p> : (
          <WorkflowContent data={data} workflow={workflow} onSelect={setSelected} names={names} />
        )}
      </div>
    </section>
  );
}

function WorkflowContent({ data, workflow, onSelect, names }: {
  data: N8nStats;
  workflow: Workflow | undefined;
  onSelect: (id: string) => void;
  names: Map<string, string>;
}) {
  return (
    <>
      {data.truncated && <p className="muted">showing the first 300 workflows</p>}
      <div className="workflow-layout">
        <div className="workflow-list" aria-label="select workflow">
          {data.workflows.map((item) => <button type="button" key={item.id} aria-pressed={item.id === workflow?.id} onClick={() => onSelect(item.id)}>
            <span>{item.name}</span><span className="muted">{item.active ? "active" : "inactive"} · {item.nodes.length} nodes</span>
          </button>)}
        </div>
        <div className="workflow-detail">
          {workflow && <><div className="workflow-heading"><strong>{workflow.name}</strong><Chip tone={workflow.active ? "solid" : "plain"}>{workflow.active ? "active" : "inactive"}</Chip></div><WorkflowGraph workflow={workflow} /></>}
        </div>
      </div>
      <p className="muted small">Execution from the dashboard is not configured. Use a supported n8n trigger; workflows may change production data.</p>
      <h3 className="subhead">recent executions · metadata only</h3>
      <ExecutionList data={data} names={names} />
    </>
  );
}

function ExecutionList({ data, names }: { data: N8nStats; names: Map<string, string> }) {
  if (!data.executionsAvailable) return <p className="empty">execution history unavailable; check API permissions</p>;
  if (!data.executions.length) return <p className="empty">no executions reported</p>;
  return <table className="table"><thead><tr><th>workflow</th><th>status</th><th className="hide-narrow">trigger</th><th className="right">started</th></tr></thead><tbody>
    {data.executions.map((run) => <tr key={run.id}>
      <td>{names.get(run.workflowId) ?? run.workflowId}</td>
      <td><Chip tone={run.status === "error" || run.status === "crashed" ? "crit" : "plain"}>{run.status}</Chip></td>
      <td className="hide-narrow muted">{run.mode}</td>
      <td className="right muted">{run.startedAt && !Number.isNaN(Date.parse(run.startedAt)) ? since(Date.parse(run.startedAt)) : "—"}</td>
    </tr>)}
  </tbody></table>;
}
