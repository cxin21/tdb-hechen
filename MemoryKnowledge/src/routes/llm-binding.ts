/**
 * LLM Binding Routes — internal, per-instance LLM routing config.
 *
 * Mounted under /v3/internal/llm-binding (prefix applied at server.ts).
 * service_id is REQUIRED via the `x-tdai-service-id` header (unified KS convention),
 * never in the body.
 *
 *   POST /set     upsert binding。DSH 特化后 mode 只剩 'custom'（该 instance 直连一个
 *                 OpenAI 兼容端点）。'proxy'（旧 context_proxy 记账通道）与 'byo'
 *                 （custom 的历史别名）均已退役，写面一律 400 拒绝，不再落库。
 *                 Idempotent — re-posting overwrites, which is how a lost binding is re-bound.
 *                 `api_key` 可选：不传时保留原值（仅对已存在的记录生效）；首次创建必填。
 *   POST /status  read-side binding status (never returns api_key)。遗留 proxy 绑定会带
 *                 `migration_required: true`，调用方据此提示迁移。
 *   POST /list    列出所有 binding（不要求 service-id 头）。返回 has_api_key 标志，
 *                 不返回 api_key 明文。
 *
 * These endpoints are internal (operator curl / Panel). KS trusts the internal
 * network like its other routes; no extra auth layer is added here.
 */

import { Hono } from "hono";

import type { ILlmBindingStore } from "../store/index.js";
import { LLM_BINDING_PROXY_RETIRED_HINT } from "../store/index.js";
import { isValidIdSegment, wrapOk, wrapError } from "../api-helpers.js";

export interface LlmBindingRouteDeps {
  llmBindingStore: ILlmBindingStore;
}

function asOptString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** POST /set 的合法 body 字段（白名单）。其余一律 400，防退役字段被静默忽略。 */
const ALLOWED_SET_KEYS = new Set(["mode", "api_key", "base_url", "enabled"]);

export function createLlmBindingRoutes(deps: LlmBindingRouteDeps): Hono {
  const app = new Hono();
  const { llmBindingStore } = deps;

  app.post("/set", async (c) => {
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) {
      return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    }
    const body = await c.req
      .json<Record<string, unknown>>()
      .catch(() => ({}) as Record<string, unknown>);

    // mode 已收窄为字面量 'custom'：'proxy' 是死路（MemoryProxy 已删），'byo' 是 custom 的
    // 历史别名。两者都在写面明确拒绝，避免调用方以为设置成功。
    if (body.mode !== "custom") {
      return c.json(
        wrapError(
          400,
          `mode=${JSON.stringify(body.mode ?? null)} 不被接受：'proxy' / 'byo' are retired，` +
            `mode 已收窄为 'custom'。请传 mode='custom' + base_url（OpenAI 兼容端点）+ api_key。`,
        ),
        400,
      );
    }
    // 白名单之外的字段一律拒绝：退役字段（proxy 那一路的地址）或拼错的字段，带上就是「没迁移完」，
    // 明确报错而不是静默忽略 —— 静默忽略等于让调用方以为设置成功。
    const unknownKeys = Object.keys(body).filter((k) => !ALLOWED_SET_KEYS.has(k));
    if (unknownKeys.length > 0) {
      return c.json(
        wrapError(
          400,
          `body 含未知或已退役字段：${unknownKeys.join(", ")}。只接受 mode / api_key / base_url / enabled；` +
            `proxy 相关字段 are retired（MemoryProxy 已退场）。${LLM_BINDING_PROXY_RETIRED_HINT}`,
        ),
        400,
      );
    }

    const mode = "custom" as const;
    const apiKey = asOptString(body.api_key);
    const baseUrl = asOptString(body.base_url);
    const enabled = body.enabled === undefined ? undefined : body.enabled !== false;

    // base_url 必填（直连端点没有地址就发不出请求）
    if (!baseUrl) {
      return c.json(wrapError(400, "custom mode requires base_url"), 400);
    }

    // api_key 校验：首次创建（KS 无此 service_id 记录）时必填；已存在记录时不传则保留原值。
    const existing = llmBindingStore.get(serviceId);
    if (!existing) {
      if (!apiKey) {
        return c.json(wrapError(400, `${mode} mode requires api_key on first set`), 400);
      }
    }

    const row = llmBindingStore.upsert(serviceId, {
      mode,
      // asOptString 返回 string | undefined；upsert 层把 undefined 解释为"保留原值"
      api_key: apiKey,
      base_url: baseUrl,
      enabled,
    });

    // Never echo api_key back.
    return c.json(
      wrapOk({
        service_id: row.service_id,
        mode: row.mode,
        enabled: row.enabled,
        updated_at: row.updated_at,
      }),
    );
  });

  app.post("/status", async (c) => {
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) {
      return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    }
    return c.json(wrapOk(llmBindingStore.status(serviceId)));
  });

  app.post("/list", async (c) => {
    // 不要求 x-tdai-service-id 头：返回所有 binding，供 Panel 观测面读取全局状态。
    const items = llmBindingStore.listAll().map((r) => ({
      service_id: r.service_id,
      mode: r.mode,
      base_url: r.base_url,
      has_api_key: !!r.api_key && r.api_key.length > 0,
      enabled: r.enabled,
      migration_required: r.migration_required,
    }));
    return c.json(wrapOk({ items }));
  });

  return app;
}
