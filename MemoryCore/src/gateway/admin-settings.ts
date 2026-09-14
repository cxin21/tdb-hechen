/**
 * /v3/admin/settings/{get,set} — Panel 透传的实例设置管理（spec §3.2）。
 * handler 签名对齐 memory-prompt-handlers.ts（v2-router routeTable 同款）。
 * envelope 构造照抄 memory-prompt-handlers.ts 真实方式：v2-router 的
 * successEnvelope / errorEnvelope（均带 request_id）。
 * 内网信任模型；管理员判定在 Panel 层（isCallerSystemAdmin）。
 */
import { errorEnvelope, successEnvelope } from "./v2-router.js";
import type { ApiResponseEnvelope, V2AuthContext } from "./v2-schemas.js";
import { readSettingsOverride, writeSettingsOverride, maskKey, validateOverride, type SettingsOverride } from "./settings-override.js";
import type { ReindexState } from "../utils/reindex-state.js";

export interface EffectiveSettings {
  llm: Record<string, unknown>;
  embedding: Record<string, unknown>;
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
  return { llm: { ...(existing?.llm ?? {}), ...incoming.llm }, embedding: { ...(existing?.embedding ?? {}), ...incoming.embedding } };
}

/** 组装 get 响应单段：合并 effective + override，掩码 key 且绝不明文回显 apiKey。 */
function maskedSection(section: Record<string, unknown>, override?: Record<string, unknown>) {
  const merged = { ...section, ...(override ?? {}) };
  const { apiKey, ...rest } = merged;
  return {
    ...rest,
    ...maskKey(typeof apiKey === "string" ? apiKey : undefined),
    source: override ? "override" : "yaml",
  };
}

export function makeAdminSettingsRouteTable(deps: AdminSettingsDeps): Record<string, AdminSettingsHandler> {
  return {
    "/v3/admin/settings/get": async (_body, _auth, requestId, _deps): Promise<ApiResponseEnvelope> => {
      const override = readSettingsOverride(deps.baseDir);
      const eff = deps.getEffective();
      return successEnvelope(
        {
          llm: maskedSection(eff.llm, override?.llm as Record<string, unknown> | undefined),
          embedding: maskedSection(eff.embedding, override?.embedding as Record<string, unknown> | undefined),
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
