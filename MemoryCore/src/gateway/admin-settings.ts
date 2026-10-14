/**
 * /v3/admin/settings/{get,set} — Panel 透传的实例设置管理（spec §3.2）。
 * handler 签名对齐 memory-prompt-handlers.ts（v2-router routeTable 同款）。
 * envelope 构造照抄 memory-prompt-handlers.ts 真实方式：v2-router 的
 * successEnvelope / errorEnvelope（均带 request_id）。
 * 内网信任模型；管理员判定在 Panel 层（isCallerSystemAdmin）。
 */
import { errorEnvelope, successEnvelope } from "./v2-router.js";
import type { ApiResponseEnvelope, V2AuthContext } from "./v2-schemas.js";
import { readSettingsOverride, writeSettingsOverride, maskKey, validateOverride, type SettingsOverride, type RerankSettingsOverride, type ImportancePenaltySettingsOverride, type WorthinessSettingsOverride } from "./settings-override.js";
import type { ReindexState } from "../utils/reindex-state.js";

export interface EffectiveSettings {
  llm: Record<string, unknown>;
  embedding: Record<string, unknown>;
  /** P1 task-4：rerank 生效值（parseMemoryConfig 输出的 memory.recall.rerank）。 */
  rerank?: Record<string, unknown>;
  /** P1 task-7：重要度降权生效值（parseMemoryConfig 输出的 memory.recall.importancePenalty）。 */
  importancePenalty?: Record<string, unknown>;
  /** P1 task-7：重要度抽取开关生效值（memory.worthiness.extractionEnabled）。 */
  worthiness?: Record<string, unknown>;
}
export interface AdminSettingsDeps {
  baseDir: string;
  getEffective: () => EffectiveSettings;
  getReindexState: () => ReindexState;
}

export type AdminSettingsHandler = (
  body: unknown,
  auth: V2AuthContext,
  requestId: string,
  deps: unknown,
) => Promise<ApiResponseEnvelope>;

function deepMerge(existing: SettingsOverride | null, incoming: SettingsOverride): SettingsOverride {
  return {
    llm: { ...(existing?.llm ?? {}), ...incoming.llm },
    embedding: { ...(existing?.embedding ?? {}), ...incoming.embedding },
    // rerank（P1 task-4）：local 子对象做一层深合并，避免「只改 idleUnloadMs
    // 时把已保存的 modelDir 整个冲掉」；顶层字段仍按段浅合并（与 llm/embedding 一致）。
    rerank: mergeRerankOverride(existing?.rerank, incoming.rerank),
    // P1 task-7：扁平段浅合并（无嵌套子对象——与局部 set 不冲掉已存字段同语义）
    importancePenalty: mergeFlatOverride<ImportancePenaltySettingsOverride>(existing?.importancePenalty, incoming.importancePenalty),
    worthiness: mergeFlatOverride<WorthinessSettingsOverride>(existing?.worthiness, incoming.worthiness),
  };
}

/** P1 task-7：扁平段（无子对象）浅合并——双方都空 → undefined。 */
function mergeFlatOverride<T extends object>(
  existing: T | undefined,
  incoming: T | undefined,
): T | undefined {
  if (!existing && !incoming) return undefined;
  return { ...(existing ?? ({} as T)), ...(incoming ?? ({} as T)) };
}

function mergeRerankOverride(
  existing: RerankSettingsOverride | undefined,
  incoming: RerankSettingsOverride | undefined,
): RerankSettingsOverride | undefined {
  if (!existing && !incoming) return undefined;
  const merged: RerankSettingsOverride = { ...(existing ?? {}), ...(incoming ?? {}) };
  if (existing?.local || incoming?.local) {
    merged.local = { ...(existing?.local ?? {}), ...(incoming?.local ?? {}) };
  }
  return merged;
}

/** 组装 get 响应单段：合并 effective + override，掩码 key 且绝不明文回显 apiKey。 */
function maskedSection(section: Record<string, unknown>, override?: Record<string, unknown>, isOverride?: boolean) {
  const merged = { ...section, ...(override ?? {}) };
  const { apiKey, ...rest } = merged;
  return {
    ...rest,
    ...maskKey(typeof apiKey === "string" ? apiKey : undefined),
    source: (isOverride ?? override !== undefined) ? "override" : "yaml",
  };
}

export function makeAdminSettingsRouteTable(deps: AdminSettingsDeps): Record<string, AdminSettingsHandler> {
  return {
    "/v3/admin/settings/get": async (_body, _auth, requestId, _deps): Promise<ApiResponseEnvelope> => {
      const override = readSettingsOverride(deps.baseDir);
      const eff = deps.getEffective();
      // rerank 段（P1 task-4）：local 子对象先与 effective 深合并一层再掩码，
      // 避免「override 只写了 local 一半字段时视图丢掉 effective 默认值」。
      const effRerank = eff.rerank ?? {};
      const ovRerank = override?.rerank;
      const mergedRerank: Record<string, unknown> = {
        ...effRerank,
        ...(ovRerank as Record<string, unknown> | undefined ?? {}),
        local: {
          ...((effRerank.local as Record<string, unknown> | undefined) ?? {}),
          ...((ovRerank?.local as Record<string, unknown> | undefined) ?? {}),
        },
      };
      return successEnvelope(
        {
          llm: maskedSection(eff.llm, override?.llm as Record<string, unknown> | undefined),
          embedding: maskedSection(eff.embedding, override?.embedding as Record<string, unknown> | undefined),
          rerank: maskedSection(mergedRerank, undefined, Boolean(ovRerank)),
          // P1 task-7：重要度降权 / worthiness 开关段（无 secret，直接掩码语义合并）
          importancePenalty: maskedSection(
            eff.importancePenalty ?? {},
            override?.importancePenalty as Record<string, unknown> | undefined,
          ),
          worthiness: maskedSection(
            eff.worthiness ?? {},
            override?.worthiness as Record<string, unknown> | undefined,
          ),
          // 与 KS 侧 /get 的 rebuildStatus 及 Panel Web SettingsView 字段名对齐（终审 F2）。
          rebuildStatus: deps.getReindexState(),
        },
        requestId,
      );
    },
    "/v3/admin/settings/set": async (body, _auth, requestId, _deps): Promise<ApiResponseEnvelope> => {
      const b = JSON.parse(JSON.stringify(body ?? {})) as Record<string, any>;
      if (b?.llm?.apiKey === "") delete b.llm.apiKey;   // 空串 = 保留原值
      if (b?.embedding?.apiKey === "") delete b.embedding.apiKey;
      if (b?.rerank?.apiKey === "") delete b.rerank.apiKey;
      const v = validateOverride(b);
      if (!v.ok) return errorEnvelope(400, v.errors.join("; "), requestId);
      const merged = deepMerge(readSettingsOverride(deps.baseDir), v.value);
      writeSettingsOverride(deps.baseDir, merged);
      const eff = deps.getEffective();
      const nextEmb = merged.embedding ?? {};
      const embeddingChanged =
        (nextEmb.model !== undefined && nextEmb.model !== eff.embedding.model) ||
        (nextEmb.dimensions !== undefined && nextEmb.dimensions !== eff.embedding.dimensions);
      return successEnvelope({ needsRestart: true, embeddingChanged }, requestId);
    },
  };
}
