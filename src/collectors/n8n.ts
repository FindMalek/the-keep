import { readText } from "../lib/host";
import { randomUUID } from "node:crypto";
import { mkdir, rename } from "node:fs/promises";
import type { N8nStats } from "../shared/types";

type Node = { name: string; type: string; position?: number[]; disabled?: boolean };
type Workflow = { id: string; name: string; active: boolean; nodes?: Node[]; connections?: Record<string, Record<string, ({ node: string }[] | null)[]>> };
type Execution = { id: string; workflowId: string; status: string; mode: string; startedAt: string | null; stoppedAt: string | null };
type Page<T> = { data: T[]; nextCursor?: string | null };

const empty = (status: N8nStats["status"]): N8nStats => ({ status, workflows: [], executions: [], executionsAvailable: false, truncated: false });

async function hostReading(dataDir: string): Promise<N8nStats> {
  const text = await readText(`${dataDir}/n8n-status.json`);
  if (!text) return empty("not configured");
  try {
    const data = JSON.parse(text) as N8nStats & { updatedAt?: number };
    const age = Date.now() - (data.updatedAt ?? 0);
    if (data.status !== "connected" || age < -60_000 || age > 180_000 || !Array.isArray(data.workflows) || !Array.isArray(data.executions)) return empty("unreachable");
    return { status: "connected", workflows: data.workflows, executions: data.executions, executionsAvailable: data.executionsAvailable, truncated: data.truncated };
  } catch {
    return empty("unreachable");
  }
}

export async function requestN8nRun(dataDir: string, action: string): Promise<boolean> {
  const match = /^run-n8n:([A-Za-z0-9_-]{1,100})$/.exec(action);
  if (!match) return false;
  const data = await hostReading(dataDir);
  if (data.status !== "connected" || !data.workflows.some((workflow) => workflow.id === match[1] && workflow.runnable)) return false;
  const dir = `${dataDir}/n8n-requests`;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = `${dir}/${Date.now()}-${randomUUID()}`;
  await Bun.write(`${path}.tmp`, JSON.stringify({ workflowId: match[1] }));
  await rename(`${path}.tmp`, `${path}.json`);
  return true;
}

export async function collectN8n(baseUrl: string | null, dataDir: string): Promise<N8nStats> {
  if (!baseUrl) return hostReading(dataDir);
  const env = (await readText(`${dataDir}/integrations.env`)) ?? "";
  const key = process.env.N8N_API_KEY ?? /^N8N_API_KEY=(.+)$/m.exec(env)?.[1]?.trim();
  if (!key) return hostReading(dataDir);

  const get = async <T>(path: string): Promise<T> => {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/v1/${path}`, {
      headers: { "X-N8N-API-KEY": key },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`n8n returned ${response.status}`);
    return await response.json() as T;
  };

  try {
    const workflows: Workflow[] = [];
    let cursor: string | null | undefined;
    for (let page = 0; page < 3; page++) {
      const result: Page<Workflow> = await get(`workflows?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      workflows.push(...result.data);
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    const executions = await get<Page<Execution>>("executions?limit=50").catch(() => null);
    const host = await hostReading(dataDir);
    const allowed = new Set(host.status === "connected" ? host.workflows.filter((workflow) => workflow.runnable).map((workflow) => workflow.id) : []);
    return {
      status: "connected",
      truncated: !!cursor,
      executionsAvailable: executions !== null,
      workflows: workflows.map((workflow) => ({
        id: workflow.id,
        name: workflow.name,
        active: workflow.active,
        runnable: allowed.has(workflow.id),
        nodes: (workflow.nodes ?? []).map((node, index) => ({
          name: node.name,
          type: node.type,
          x: Number.isFinite(node.position?.[0]) ? node.position![0]! : index * 200,
          y: Number.isFinite(node.position?.[1]) ? node.position![1]! : 0,
          disabled: node.disabled ?? false,
        })),
        edges: Object.entries(workflow.connections ?? {}).flatMap(([from, types]) =>
          Object.values(types).flatMap((outputs) => outputs.flatMap((targets) => (targets ?? []).map((target) => ({ from, to: target.node }))))),
      })),
      executions: (executions?.data ?? []).map((run) => ({ id: run.id, workflowId: run.workflowId, status: run.status, mode: run.mode, startedAt: run.startedAt, stoppedAt: run.stoppedAt })),
    };
  } catch {
    const host = await hostReading(dataDir);
    return host.status === "connected" ? host : empty("unreachable");
  }
}
