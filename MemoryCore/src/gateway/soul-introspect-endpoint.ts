/**
 * #36（R5）：POST /v3/soul/introspect —— 只读自省端点（soul-introspect.ts 的 HTTP 薄适配，
 * 与 rerank-endpoint.ts 同构）。Bearer 门禁由 server.ts dispatch 层先行；本函数不做鉴权。
 * Body：{ teamId?, userId?, agentId?, snapshotLimit?, evidenceWindowHours?, renderOpts?, probes?, evidence? }。
 * 零写入合同：handler 只调 introspectSoul（其内部 buildSoulPrefix 强制 snapshotsEnabled:false）。
 * #36 保真度补全：renderOpts 合并序 = defaultRenderOpts（server 侧生产配置镜像）
 *   ← moodTier（moodTierProvider 现算，抛错非致命降级=省略基调行）
 *   ← state（stateProvider 现读，抛错非致命降级=省略状态行）← body.renderOpts（逐键最后覆盖）——
 * 保证探针/孤儿锚评估的是与生产注入同形的文本。
 */
import type { IMemoryStore, CoreTenant } from "../core/store/types.js";
import type { SoulRenderOptions } from "../core/hooks/soul-assembler.js";
import type { MoodTier } from "../core/hooks/mood-line.js";
import type { SoulState } from "../core/hooks/soul-state.js";
import { introspectSoul, type IntrospectProbe } from "../core/hooks/soul-introspect.js";

export interface SoulIntrospectRouteDeps {
  getStore: () => IMemoryStore | null;
  defaults?: { snapshotLimit?: number; evidenceWindowHours?: number };
  /** #36 保真度补全：生产 soul 渲染配置镜像（server 侧组装），探针评估同形文本的基座。 */
  defaultRenderOpts?: Omit<SoulRenderOptions, "snapshotsEnabled">;
  /** #36 保真度补全：现算近期基调（与 auto-recall 同源 computeMoodTierFromStore）；抛错由 handler 降级。 */
  moodTierProvider?: (tenant: CoreTenant) => Promise<{ tier: MoodTier; sampleCount: number } | null>;
  /** #36 保真度补全：现读当下状态（与 auto-recall.ts:989 接线同源 readSoulState，字段映射 updatedAt→at）；抛错由 handler 降级。 */
  stateProvider?: (tenant: CoreTenant) => Promise<SoulState | null>;
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
    // #36 保真度补全：moodTier 现算（provider 抛错非致命：warn + 省略基调行，其余段照常）。
    let moodTier: { tier: MoodTier; sampleCount: number } | null = null;
    if (deps.moodTierProvider) {
      try {
        moodTier = await deps.moodTierProvider(tenant);
      } catch (err) {
        deps.logger?.warn?.(
          `[soul-introspect-endpoint] mood compute failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // #36 保真度补全：state 现读（provider 抛错非致命：warn + 省略状态行，其余段照常）。
    let state: SoulState | null = null;
    if (deps.stateProvider) {
      try {
        state = await deps.stateProvider(tenant);
      } catch (err) {
        deps.logger?.warn?.(
          `[soul-introspect-endpoint] state read failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const data = await introspectSoul(store, tenant, {
      logger: deps.logger as never,
      snapshotLimit: typeof b.snapshotLimit === "number" ? b.snapshotLimit : deps.defaults?.snapshotLimit,
      evidenceWindowHours:
        typeof b.evidenceWindowHours === "number" ? b.evidenceWindowHours : deps.defaults?.evidenceWindowHours,
      // #36 保真度补全：合并序 defaultRenderOpts ← moodTier ← state ← body.renderOpts（body 逐键最后覆盖）。
      renderOpts: {
        ...(deps.defaultRenderOpts ?? {}),
        ...(moodTier ? { moodTier } : {}),
        ...(state ? { state } : {}),
        ...((b.renderOpts ?? {}) as Record<string, unknown>),
      } as never,
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
