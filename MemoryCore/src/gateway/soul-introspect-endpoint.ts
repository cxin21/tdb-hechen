/**
 * #36（R5）：POST /v3/soul/introspect —— 只读自省端点（soul-introspect.ts 的 HTTP 薄适配，
 * 与 rerank-endpoint.ts 同构）。Bearer 门禁由 server.ts dispatch 层先行；本函数不做鉴权。
 * Body：{ teamId?, userId?, agentId?, snapshotLimit?, evidenceWindowHours?, renderOpts?, probes?, evidence? }。
 * 零写入合同：handler 只调 introspectSoul（其内部 buildSoulPrefix 强制 snapshotsEnabled:false）。
 */
import type { IMemoryStore } from "../core/store/types.js";
import { introspectSoul, type IntrospectProbe } from "../core/hooks/soul-introspect.js";

export interface SoulIntrospectRouteDeps {
  getStore: () => IMemoryStore | null;
  defaults?: { snapshotLimit?: number; evidenceWindowHours?: number };
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void; error?: (msg: string) => void };
}

export interface SoulIntrospectCoreDeps extends SoulIntrospectRouteDeps {
  now?: () => number;
}

export async function handleSoulIntrospectCore(
  body: unknown,
  deps: SoulIntrospectCoreDeps,
): Promise<{ status: number; payload: unknown }> {
  const store = deps.getStore();
  if (!store) return { status: 503, payload: { code: 503, message: "soul_introspect_unavailable" } };
  const b = (body ?? {}) as Record<string, unknown>;
  const tenant = {
    teamId: typeof b.teamId === "string" && b.teamId !== "" ? b.teamId : "default",
    userId: typeof b.userId === "string" && b.userId !== "" ? b.userId : "default",
    agentId: typeof b.agentId === "string" && b.agentId !== "" ? b.agentId : "default",
  };
  try {
    const data = await introspectSoul(store, tenant, {
      logger: deps.logger as never,
      snapshotLimit: typeof b.snapshotLimit === "number" ? b.snapshotLimit : deps.defaults?.snapshotLimit,
      evidenceWindowHours:
        typeof b.evidenceWindowHours === "number" ? b.evidenceWindowHours : deps.defaults?.evidenceWindowHours,
      renderOpts: (b.renderOpts ?? {}) as never,
      probes: Array.isArray(b.probes) ? (b.probes as IntrospectProbe[]) : undefined,
      evidence: Array.isArray(b.evidence)
        ? (b.evidence as Array<unknown>)
            .filter((e): e is { content: string; at?: string } =>
              typeof e === "object" && e !== null && typeof (e as { content?: unknown }).content === "string")
            .map((e) => ({ content: e.content, at: typeof e.at === "string" ? e.at : undefined }))
        : undefined,
    });
    return { status: 200, payload: { code: 0, data } };
  } catch (err) {
    deps.logger?.warn?.(`[soul-introspect-endpoint] introspect failed: ${err instanceof Error ? err.message : String(err)}`);
    return { status: 503, payload: { code: 503, message: "soul_introspect_failed" } };
  }
}

export async function handleSoulIntrospectRoute(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  pathname: string,
  method: string,
  parseJsonBody: (req: import("node:http").IncomingMessage, limitBytes?: number) => Promise<unknown>,
  sendJson: (res: import("node:http").ServerResponse, status: number, payload: unknown) => void,
  deps: SoulIntrospectRouteDeps,
): Promise<boolean> {
  if (method !== "POST" || pathname !== "/v3/soul/introspect") return false;
  let body: unknown;
  try {
    body = await parseJsonBody(req);
  } catch {
    sendJson(res, 400, { code: 400, message: "invalid JSON body" });
    return true;
  }
  const result = await handleSoulIntrospectCore(body, deps);
  sendJson(res, result.status, result.payload);
  return true;
}
