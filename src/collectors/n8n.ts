import { readText } from "../lib/host";
import type { N8nStats } from "../shared/types";

type Node = { name: string; type: string; position?: number[]; disabled?: boolean };
type Workflow = { id: string; name: string; active: boolean; nodes?: Node[]; connections?: Record<string, Record<string, ({ node: string }[] | null)[]>> };
type Execution = { id: string; workflowId: string; status: string; mode: string; startedAt: string | null; stoppedAt: string | null };
type Page<T> = { data: T[]; nextCursor?: string | null };

const empty = (status: N8nStats["status"]): N8nStats => ({ status, workflows: [], executions: [], executionsAvailable: false, truncated: false });

export async function collectN8n(baseUrl: string | null, dataDir: string): Promise<N8nStats> {
  if (!baseUrl) return empty("not configured");
  const env = (await readText(`${dataDir}/integrations.env`)) ?? "";
  const key = process.env.N8N_API_KEY ?? /^N8N_API_KEY=(.+)$/m.exec(env)?.[1]?.trim();
  if (!key) return empty("not configured");

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
    return {
      status: "connected",
      truncated: !!cursor,
      executionsAvailable: executions !== null,
      workflows: workflows.map((workflow) => ({
        id: workflow.id,
        name: workflow.name,
        active: workflow.active,
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
    return empty("unreachable");
  }
}
