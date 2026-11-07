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
  /** P1 task-4：rerank 生效值（parseMemoryConfig 输出的 memory.recall.rerank）。 */
  rerank?: Record<string, unknown>;
  /** P1 task-7：重要度降权生效值（parseMemoryConfig 输出的 memory.recall.importancePenalty）。 */
  importancePenalty?: Record<string, unknown>;
  /** P1 task-7：重要度抽取开关生效值（memory.worthiness.extractionEnabled）。 */
  worthiness?: Record<string, unknown>;
  /** 2026-11-07：应急回滚开关与校准阈值所在组的生效值（settings 页签 B/C 读取）。 */
  extraction?: Record<string, unknown>;
  layerRuler?: Record<string, unknown>;
  injection?: Record<string, unknown>;
  coreMemory?: Record<string, unknown>;
  capture?: Record<string, unknown>;
  evolution?: Record<string, unknown>;
  sceneGovernance?: Record<string, unknown>;
  links?: Record<string, unknown>;
  bm25?: Record<string, unknown>;
  search?: Record<string, unknown>;
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
  // 逐段深合并：数组/标量整体替换，普通对象递归。旧实现只列了 5 个段，
  // 导致 extraction / layerRuler / injection / recall / persona / lifecycle
  // 通过 /set 提交时被静默丢弃（validate 通过但落盘 = 空）——2026-11-07 修复。
  const out: SettingsOverride = copyDefined(existing);
  for (const [section, patch] of Object.entries(copyDefined(incoming))) {
    const cur = (out as Record<string, unknown>)[section];
    (out as Record<string, unknown>)[section] =
      isPlainObject(patch) && isPlainObject(cur) ? deepMergePlain(cur, patch) : patch;
  }
  return out;
}

/** 只保留非 undefined 字段（顶层）；不改入参。 */
function copyDefined(o: SettingsOverride | null | undefined): SettingsOverride {
  return Object.fromEntries(
    Object.entries(o ?? {}).filter(([, v]) => v !== undefined),
  ) as SettingsOverride;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMergePlain(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const cur = out[k];
    out[k] = isPlainObject(v) && isPlainObject(cur) ? deepMergePlain(cur, v) : v;
  }
  return out;
}

/** 组装 get 响应单段：合并 effective + override，掩码 key 且绝不明文回显 apiKey。 */
function maskedSection(section: Record<string, unknown>, override?: Record<string, unknown>, isOverride?: boolean) {
  const merged = { ...section, ...(override ?? {}) };
  // shadowMode 键已按用户 2026-10-14 拍板整体移除（P1 M1/M3）：存量 override 文件
  // 可能仍携带旧键，回显前显式剥除，避免已删除的配置项借旧数据复活。
  delete merged.shadowMode;
  const { apiKey, ...rest } = merged;
  return {
    ...rest,
    ...maskKey(typeof apiKey === "string" ? apiKey : undefined),
    source: (isOverride ?? override !== undefined) ? "override" : "yaml",
  };
}

/**
 * 整组回显：effective 与已落盘 override 深合并（/set 后未重启也能立刻看到新值），
 * 只剥掉已废弃的 shadowMode，不注入掩码/来源元字段（组内无凭据）。
 */
function plainSection(
  section: Record<string, unknown> | undefined,
  override?: unknown,
): Record<string, unknown> {
  const merged = isPlainObject(override)
    ? deepMergePlain(section ?? {}, override)
    : { ...(section ?? {}) };
  const { shadowMode: _shadowMode, ...rest } = merged;
  return rest;
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
          // 2026-11-07：设置页 B（应急开关）/ C（校准阈值）读取的整组生效值。
          // 这些组的 override 已在 parse 之前并入，eff 即最终值，无需再叠 override；
          // 组内没有凭据，故不走 maskedSection（否则会混入 source/apiKeyMasked 元字段）。
          extraction: plainSection(eff.extraction, override?.extraction),
          layerRuler: plainSection(eff.layerRuler, override?.layerRuler),
          injection: plainSection(eff.injection, override?.injection),
          coreMemory: plainSection(eff.coreMemory, override?.coreMemory),
          capture: plainSection(eff.capture, override?.capture),
          evolution: plainSection(eff.evolution, override?.evolution),
          sceneGovernance: plainSection(eff.sceneGovernance, override?.sceneGovernance),
          links: plainSection(eff.links, override?.links),
          bm25: plainSection(eff.bm25, override?.bm25),
          search: plainSection(eff.search, override?.search),
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
