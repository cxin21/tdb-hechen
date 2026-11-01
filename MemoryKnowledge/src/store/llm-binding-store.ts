/**
 * LlmBindingStore — per-instance (service_id) LLM routing binding.
 *
 * Decoupled from IKnowledgeStore: a single small table keyed by service_id that
 * tells wiki ingest/summary which LLM endpoint to use for that instance.
 *
 * DSH 特化（Wave 3）：接入方只剩 DSH 插件 + Panel 观测面，MemoryProxy 已整包退场，
 * 因此绑定只保留**一个**语义：
 *   - mode='custom' → 该 instance 直连一个 OpenAI 兼容端点（base_url + api_key）。
 *
 * 历史值处置（不打「静默当 custom」的折扣）：
 *   - 库里遗留 mode='proxy' 的行是**死路**（它指向已删除的 MemoryProxy :8096）：
 *     读取侧（status/list）标 `migration_required: true` 让人看见，
 *     运行侧（resolveLlmConfig）**抛 LlmBindingRetiredError** 并给出迁移命令 —— 绝不悄悄回落。
 *   - 库里遗留 mode='byo' 的行语义与 custom 完全相同（都是用户自带端点），
 *     读取时归一为 custom，不需要数据迁移。
 *
 * No binding (or disabled/incomplete) → 直接用全局 LLM_* (LLM_MODE=custom 直连)。
 *
 * Model 不按 instance 存 —— 恒来自全局 `LLM_MODEL`（单一真相源，见 resolveLlmConfig）。
 */

import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { llmBinding } from "../db/schema.js";
import type { LlmConfig } from "../config.js";

/** 写面唯一合法值（POST /set 只接受它）。 */
export type LlmBindingMode = "custom";

/**
 * 库里可能出现的原始值。'proxy' 是退役值（迁移前的老数据），'byo' 是 custom 的历史别名。
 * 仅用于读取侧识别，写面永远只写 'custom'。
 */
export type StoredLlmBindingMode = "custom" | "proxy" | "byo";

/** 读到退役绑定时的统一迁移提示（错误消息与 status/list 的 note 共用同一段文案）。 */
export const LLM_BINDING_PROXY_RETIRED_HINT =
  "mode='proxy' is retired（MemoryProxy 已随 DSH 特化退场）：请把该 service_id 的绑定改为 mode='custom' " +
  "并配置 base_url（OpenAI 兼容端点）+ api_key；或删除该行回落到全局 LLM_MODE=custom 的 LLM_BASE_URL / LLM_API_KEY。";

/** fail-loud：运行期解析到退役绑定就抛，绝不静默按 custom 走。 */
export class LlmBindingRetiredError extends Error {
  readonly code = "LLM_BINDING_MODE_RETIRED";
  constructor(readonly serviceId: string) {
    super(`llm_binding service_id=${serviceId} ${LLM_BINDING_PROXY_RETIRED_HINT}`);
    this.name = "LlmBindingRetiredError";
  }
}

export interface LlmBindingRow {
  service_id: string;
  /** 库里原始 mode（可能是退役的 'proxy'）。 */
  mode: StoredLlmBindingMode;
  api_key: string | null;
  base_url: string | null;
  enabled: boolean;
  updated_at: string;
  /** true = 该行是退役的 proxy 绑定，必须人工迁移后才能用。 */
  migration_required: boolean;
}

/** Upsert payload (service_id comes from the header, not the body).
 *  `api_key: undefined` 表示保留原值（用于只改 base_url / enabled 的场景）；
 *  `api_key: null` 表示清空；`api_key: "xxx"` 表示更新。 */
export interface LlmBindingInput {
  mode: LlmBindingMode;
  api_key?: string | null;
  base_url?: string | null;
  enabled?: boolean;
}

/** Read-side status (never exposes api_key). */
export interface LlmBindingStatus {
  bound: boolean;
  mode: StoredLlmBindingMode | null;
  enabled: boolean;
  /** true = 库里的绑定是退役的 proxy 模式，调用方必须先迁移。 */
  migration_required: boolean;
}

export interface ILlmBindingStore {
  get(serviceId: string): LlmBindingRow | null;
  listAll(): LlmBindingRow[];
  upsert(serviceId: string, input: LlmBindingInput): LlmBindingRow;
  status(serviceId: string): LlmBindingStatus;
}

export function createLlmBindingStore(db: Db): ILlmBindingStore {
  return {
    get(serviceId: string): LlmBindingRow | null {
      const rows = db.select().from(llmBinding).where(eq(llmBinding.serviceId, serviceId)).all();
      const row = rows[0];
      return row ? toRow(row) : null;
    },

    listAll(): LlmBindingRow[] {
      const rows = db.select().from(llmBinding).all();
      return rows.map(toRow);
    },

    upsert(serviceId: string, input: LlmBindingInput): LlmBindingRow {
      const now = new Date().toISOString();
      const existing = this.get(serviceId);
      // api_key: undefined → 保留原值（仅 upsert 已存在记录时）；null → 清空；string → 更新
      const apiKey = input.api_key !== undefined ? input.api_key : (existing?.api_key ?? null);
      const values = {
        serviceId,
        mode: input.mode,
        apiKey,
        baseUrl: input.base_url ?? null,
        enabled: input.enabled === false ? 0 : 1,
        updatedAt: now,
      };
      db.insert(llmBinding)
        .values(values)
        .onConflictDoUpdate({
          target: llmBinding.serviceId,
          set: {
            mode: values.mode,
            apiKey: values.apiKey,
            baseUrl: values.baseUrl,
            enabled: values.enabled,
            updatedAt: values.updatedAt,
          },
        })
        .run();
      return this.get(serviceId)!;
    },

    status(serviceId: string): LlmBindingStatus {
      const row = this.get(serviceId);
      if (!row) return { bound: false, mode: null, enabled: false, migration_required: false };
      return {
        bound: true,
        mode: row.mode,
        enabled: row.enabled,
        migration_required: row.migration_required,
      };
    },
  };
}

function toRow(r: typeof llmBinding.$inferSelect): LlmBindingRow {
  // 库里 mode 是自由文本：除 'proxy'（退役）与 'byo'（custom 别名）外一律按 custom 处理。
  const stored = r.mode === "proxy" || r.mode === "byo" ? r.mode : "custom";
  return {
    service_id: r.serviceId,
    mode: stored,
    api_key: r.apiKey ?? null,
    base_url: r.baseUrl ?? null,
    enabled: r.enabled !== 0,
    updated_at: r.updatedAt,
    migration_required: stored === "proxy",
  };
}

/**
 * Pure resolver: turn a binding (or its absence) into an effective LlmConfig.
 * 绑定的 mode 'custom' 与历史别名 'byo' 都是「直连用户自带端点」，只覆盖 baseUrl/apiKey。
 *
 * Model always comes from `fallback.model` (= global `LLM_MODEL` env) — no
 * per-instance model storage, single source of truth.
 *
 * 无可用绑定 → 直接用全局 fallback（LLM_MODE=custom 的 LLM_* 直连）。
 * 遇到退役的 mode='proxy' 绑定 → 抛 LlmBindingRetiredError（fail-loud，带迁移命令），
 * 绝不静默回落，否则「绑定错配」会伪装成「没配置」。
 */
export function resolveLlmConfig(
  serviceId: string,
  binding: LlmBindingRow | null,
  fallback: LlmConfig,
): LlmConfig {
  if (!binding || !binding.enabled) return fallback;

  if (binding.mode === "proxy") throw new LlmBindingRetiredError(serviceId);

  // custom（含历史别名 byo）：端点或 key 不全 → 回落全局；不抛错，因为「半配置」的
  // 修复动作就是补全端点，报错文案由 createLlmClient 负责（apiKey 缺失时抛）。
  if (!binding.base_url || !binding.api_key) return fallback;

  return { ...fallback, apiKey: binding.api_key, baseUrl: binding.base_url };
}
