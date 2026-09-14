/**
 * Admin settings routes — /v3/admin/settings/{get,set,revectorize}。
 * 内网信任模型（与 /v3/internal/llm-binding 一致）；管理员判定由 Panel 层完成。
 * 变更落 {dataDir}/config-override.json，重启后经 loadConfig 合并生效（spec §3.1）。
 */
import { Hono } from "hono";
import {
  readSettingsOverride, writeSettingsOverride, maskKey, validateOverride,
  type SettingsOverride,
} from "../config-override.js";
import { wrapOk, wrapError } from "../api-helpers.js";
import type { ServiceConfig } from "../config.js";

export interface AdminSettingsDeps {
  config: ServiceConfig;
  dataDir: string;
  /** Task 3 接线后注入；缺省时 rebuildStatus 恒为 idle、revectorize 返回 400。 */
  getVectorStatus?: () => unknown;
  forceRevectorize?: () => Promise<boolean>;
}

function deepMergeOverride(existing: SettingsOverride | null, incoming: SettingsOverride): SettingsOverride {
  return {
    llm: { ...(existing?.llm ?? {}), ...incoming.llm },
    embedding: { ...(existing?.embedding ?? {}), ...incoming.embedding },
  };
}

/** GET 响应剔除明文 apiKey（全局约束：apiKey 永不明文回显，只回 hasApiKey+掩码）。 */
function stripApiKey<T extends { apiKey?: string }>(o: T): Omit<T, "apiKey"> {
  const { apiKey: _omit, ...rest } = o;
  return rest;
}

export function createAdminSettingsRoutes(deps: AdminSettingsDeps): Hono {
  const app = new Hono();
  const { config, dataDir } = deps;

  app.post("/get", (c) => {
    const override = readSettingsOverride(dataDir);
    const effectiveLlm = { ...config.llm, ...(override?.llm ?? {}) };
    const effectiveEmb = { ...config.embedding, ...(override?.embedding ?? {}) };
    return c.json(wrapOk({
      llm: { ...stripApiKey(effectiveLlm), ...maskKey(effectiveLlm.apiKey), source: override?.llm ? "override" : "env" },
      embedding: { ...stripApiKey(effectiveEmb), ...maskKey(effectiveEmb.apiKey), source: override?.embedding ? "override" : "env" },
      rebuildStatus: deps.getVectorStatus?.() ?? { status: "idle" },
    }));
  });

  app.post("/set", async (c) => {
    // spec §3.3：非法/空 body 必须显式 400，不得静默成功
    const parsed = await c.req.json<Record<string, any>>().catch(() => null);
    if (parsed === null) return c.json(wrapError(400, "请求体不是合法 JSON"), 400);
    const isObj = (v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v);
    if (!isObj(parsed.llm) && !isObj(parsed.embedding)) {
      return c.json(wrapError(400, "body 必须包含 llm 或 embedding 至少一项"), 400);
    }
    const body = parsed;
    // apiKey 空串 = 保留原值：剥掉后不落盘（maskKey 语义见 spec §3.1）
    if (body?.llm?.apiKey === "") delete body.llm.apiKey;
    if (body?.embedding?.apiKey === "") delete body.embedding.apiKey;
    const v = validateOverride(body);
    if (!v.ok) return c.json(wrapError(400, v.errors.join("; ")), 400);
    const existing = readSettingsOverride(dataDir);
    const merged = deepMergeOverride(existing, v.value);
    writeSettingsOverride(dataDir, merged);
    const nextEmb = merged.embedding ?? {};
    const embeddingChanged =
      (nextEmb.model !== undefined && nextEmb.model !== config.embedding.model) ||
      (nextEmb.dimensions !== undefined && nextEmb.dimensions !== config.embedding.dimensions);
    return c.json(wrapOk({ needsRestart: true, embeddingChanged }));
  });

  // F3：fire-and-forget —— 不再 await 重建本体（可能数分钟，Panel 侧会超时）。
  // 守卫信息透出：重建已在跑时 forceRevectorizeAll 会静默拒绝，故先同步读同一
  // vectorStatus（与 manager 守卫同源，且两者处于同一同步执行窗口、无 await 间隔，
  // 不存在 TOCTOU）——running → 409 {started:false}；否则触发重建并立即 started:true。
  app.post("/revectorize", (c) => {
    if (!deps.forceRevectorize) return c.json(wrapError(400, "embedding 未配置或未接线"), 400);
    const vs = deps.getVectorStatus?.() as { status?: string } | undefined;
    if (vs?.status === "running") {
      return c.json({ ...wrapError(409, "rebuild already running"), data: { started: false } }, 409);
    }
    void deps.forceRevectorize();
    return c.json(wrapOk({ started: true }));
  });

  return app;
}
