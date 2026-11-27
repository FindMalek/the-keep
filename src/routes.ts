import { bucketResponse, type BucketSource } from "./collectors/garage-s3";
import { JournalError, parseLogQuery, type Journal } from "./collectors/logs";
import { toHandoffMarkdown } from "./sessions/export";
import type { SessionFilter, SessionStore } from "./sessions/store";
import { isParsedSession } from "./sessions/validate";
import type { ModelPrice, SessionsPayload } from "./shared/types";

/** Client-side routes; each serves the app shell. */
export const PAGE_PATHS = ["/", "/apps", "/system", "/jobs", "/logs", "/activity", "/sessions", "/media", "/overview", "/uptime", "/buckets"];

export interface ApiDeps {
  sessions: SessionStore;
  journal: Journal | null;
  jobNames: () => string[];
  buckets: () => BucketSource | null;
  bucketNames: () => string[];
}

const DAY = 86_400_000;
const num = (value: string | null) => (value && Number.isFinite(Number(value)) ? Number(value) : null);

function sessionFilter(params: URLSearchParams): SessionFilter {
  return {
    limit: Math.min(200, Math.max(1, num(params.get("limit")) ?? 50)),
    offset: Math.max(0, num(params.get("offset")) ?? 0),
    tool: params.get("tool"),
    machine: params.get("machine"),
    project: params.get("project"),
    model: params.get("model"),
    q: params.get("q")?.slice(0, 200) || null,
    from: num(params.get("from")),
    to: num(params.get("to")),
  };
}

const forbidden = (request: Request) => request.headers.get("x-keep-action") !== "1";

async function journalCall<T>(journal: Journal | null, work: (journal: Journal) => Promise<T>): Promise<Response> {
  if (!journal) return new Response("journal not mounted", { status: 503 });
  try {
    return Response.json(await work(journal));
  } catch (error) {
    // journalctl's own message (a bad --grep pattern, an unknown boot) is what the user needs to see.
    if (error instanceof JournalError) return new Response(error.message, { status: 400 });
    throw error;
  }
}

/** Routes for sessions, prices, logs, job runs and buckets; the server and the fixture dev script both mount them. */
export function apiRoutes({ sessions, journal, jobNames, buckets, bucketNames }: ApiDeps) {
  return {
    "/api/sessions": {
      GET: (request: Request) => {
        const params = new URL(request.url).searchParams;
        const filter = sessionFilter(params);
        const payload: SessionsPayload = {
          sessions: sessions.list(filter),
          total: sessions.count(filter),
          // The overview only needs usage once; later pages of the list skip it.
          usage: filter.offset ? [] : sessions.usageByDay(Date.now() - 90 * DAY, num(params.get("tz")) ?? 0),
          pricesUpdatedAt: sessions.prices.updatedAt,
        };
        return Response.json(payload);
      },
      POST: async (request: Request) => {
        if (forbidden(request)) return new Response("missing header", { status: 403 });
        const body = await request.json().catch(() => null);
        const batch = Array.isArray(body) ? body : [body];
        if (!batch.length || !batch.every(isParsedSession)) return new Response("bad payload", { status: 400 });
        for (const parsed of batch) sessions.upsert(parsed);
        return new Response(null, { status: 202 });
      },
    },
    "/api/sessions/facets": () => Response.json(sessions.facets()),
    "/api/session": (request: Request) => {
      const params = new URL(request.url).searchParams;
      const parsed = sessions.get(params.get("id") ?? "");
      if (!parsed) return new Response("not found", { status: 404 });
      if (params.get("as") === "markdown") return new Response(toHandoffMarkdown(parsed), { headers: { "content-type": "text/markdown; charset=utf-8" } });
      const costs = parsed.messages.map((message) => (message.role === "assistant" ? sessions.prices.cost(message, parsed.session.tool) : null));
      return Response.json({ ...parsed, costs });
    },
    "/api/prices": () => {
      const models = sessions.facets().models;
      const providers = new Map(sessions.providers().map((provider) => [provider, provider]));
      const rows = models.map((model) => {
        const history = [...providers.keys(), null].map((provider) => sessions.prices.resolve(provider, model)).find(Boolean);
        return { model, price: (history?.at(-1) ?? null) as ModelPrice | null };
      });
      return Response.json({ updatedAt: sessions.prices.updatedAt, models: rows });
    },
    "/api/logs": (request: Request) => {
      const query = parseLogQuery(new URL(request.url).searchParams);
      if (typeof query === "string") return new Response(query, { status: 400 });
      return journalCall(journal, (j) => j.page(query));
    },
    "/api/logs/entry": (request: Request) => {
      const cursor = new URL(request.url).searchParams.get("cursor") ?? "";
      return journalCall(journal, (j) => j.entry(cursor));
    },
    "/api/logs/histogram": (request: Request) => {
      const params = new URL(request.url).searchParams;
      const query = parseLogQuery(params);
      if (typeof query === "string") return new Response(query, { status: 400 });
      const to = num(params.get("to")) ?? Date.now();
      // Counting reads every entry in the range; past two days it is too slow to do per request.
      const from = Math.max(num(params.get("from")) ?? to - 3600_000, to - 2 * DAY);
      const count = Math.min(240, Math.max(8, num(params.get("buckets")) ?? 60));
      return journalCall(journal, (j) => j.histogram(query, from, to, count));
    },
    "/api/logs/units": () => journalCall(journal, (j) => j.units()),
    "/api/logs/boots": () => journalCall(journal, (j) => j.boots()),
    "/api/jobs/runs": (request: Request) => {
      const params = new URL(request.url).searchParams;
      const name = params.get("name") ?? "";
      if (!/^[a-z][\w-]{0,63}$/.test(name) || !jobNames().includes(name)) return new Response("unknown job", { status: 404 });
      const limit = Math.min(5, Math.max(1, num(params.get("limit")) ?? 2));
      return journalCall(journal, (j) => j.runs(`${name}.service`, limit));
    },
    "/api/buckets/:name/:op": (request: Request) => {
      const source = buckets();
      if (!source) return new Response("bucket browsing needs GARAGE_S3_KEY and GARAGE_S3_SECRET", { status: 503 });
      return bucketResponse(source, bucketNames(), request);
    },
  };
}
