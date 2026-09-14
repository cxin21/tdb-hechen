/**
 * V2-2 引擎一 · 查询自动扩展（DS-RECALL-V2-THREE-ENGINES-001 §E1.1-E1.4）。
 *
 * 职责（纯语义扩展，零语料泄漏——prompt 不给任何记忆内容）：
 *   buildExpansionPrompt  → E1.2 逐字 prompt（JSON 字符串数组，5-8 个）；
 *   parseExpansion        → 解析防御：非串丢弃 / trim / 去重（大小写不敏感）/
 *                           去除与原 query 相同项 / maxTerms 截断；
 *   expandQuery           → standalone runner 调用（C2 derive 模式）+ 失败/超时 → []
 *                           （E1.4 失败退化：原 query 照常）+ TTL 缓存（E1.2，10 分钟）；
 *   mergeFtsQueryWithExpansion → E1.3 FTS OR 合并（词面足迹 widening；向量路不动）。
 *
 * 不变式：扩展只加候选，绝对门槛照常裁决（宁缺毋滥不破）；扩展词命中的条目不特殊标注。
 */
import type { Logger } from "../types.js";

/** LLM runner 最小面（与 store.deriveValueValences / anchor-growth 的 llmRunner 同形）。 */
export interface ExpansionRunner {
  run(params: {
    prompt: string;
    systemPrompt?: string;
    taskId: string;
    timeoutMs?: number;
    maxTokens?: number;
  }): Promise<string>;
}

/** E1.1 扩展开关与旋钮（config 透传见 src/config.ts recall.queryExpansion）。 */
export interface QueryExpansionConfig {
  enabled: boolean;
  maxTerms: number;
  ttlMs: number;
  timeoutMs: number;
}

export const QUERY_EXPANSION_DEFAULTS: QueryExpansionConfig = {
  enabled: true,
  maxTerms: 8,
  ttlMs: 600_000,
  timeoutMs: 8000,
};

/**
 * E1.2 maxTokens 覆写 8192（推理模型预算教训：backfill 4096 全空——thinking 占输出
 * 预算，默认 4096 会把 JSON 答案截没；runner 链 params.maxTokens 优先，llm-runner.ts）。
 */
export const QUERY_EXPANSION_MAX_TOKENS_OVERRIDE = 8192;

/** E1.1 候选池扩展（仅注入前的查询词扩展，无候选入池语义——探索位候选资格不含本引擎）。 */
const EXPANSION_TASK_ID = "recall-query-expand";

/** E1.2 prompt（零语料泄漏——纯语义扩展，不给记忆内容；设计 §E1.2 逐字采用）。 */
export function buildExpansionPrompt(query: string): string {
  return [
    "给出与以下检索查询语义相关的搜索词（同义词/上下位概念/相关术语），",
    "用于扩大文档检索的召回范围。输出 JSON 字符串数组，5-8 个，不要解释。",
    `查询：${query}`,
  ].join("\n");
}

/**
 * E1.2 解析防御（纯函数、确定性）：
 *   - 非法 JSON / 非数组 → []；
 *   - 非字符串项丢弃；trim 后空串丢弃；
 *   - 去重（大小写不敏感——检索词面语义等价）；
 *   - 去除与原 query 相同项（original，大小写不敏感）；
 *   - maxTerms 截断（保序，先到先得）。
 */
export function parseExpansion(raw: string, opts?: { maxTerms?: number; original?: string }): string[] {
  if (!raw || typeof raw !== "string") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const maxTerms = opts?.maxTerms != null && Number.isFinite(opts.maxTerms) && opts.maxTerms > 0
    ? Math.floor(opts.maxTerms)
    : QUERY_EXPANSION_DEFAULTS.maxTerms;
  const originalLower = opts?.original?.trim().toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of parsed) {
    if (typeof item !== "string") continue;
    const t = item.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (originalLower !== undefined && key === originalLower) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= maxTerms) break;
  }
  return out;
}

// ── E1.2 TTL 缓存（E1 同款模式：Map + TTL + 200 上界 FIFO 驱逐）──

interface ExpansionCacheEntry {
  terms: string[];
  at: number;
}
const expansionCache = new Map<string, ExpansionCacheEntry>();
const EXPANSION_CACHE_MAX = 200;

/**
 * E1.2 expandQuery：LLM 语义邻域扩展（失败→[]，E1.4 失败退化 + warn 一次）。
 * 缓存 key = query 原文（同 query TTL 内复用）；ttlMs<=0 = 不缓存（直呼）；
 * 失败的调用不缓存（下次重试）。工具侧与 auto-recall 侧共用本模块 Map（同进程同缓存）。
 */
export async function expandQuery(
  query: string,
  runner: ExpansionRunner | undefined,
  opts?: { maxTerms?: number; ttlMs?: number; timeoutMs?: number; logger?: Logger },
): Promise<string[]> {
  if (!query || query.trim().length === 0) return [];
  if (!runner || typeof runner.run !== "function") return [];
  const ttlMs = opts?.ttlMs ?? QUERY_EXPANSION_DEFAULTS.ttlMs;
  const timeoutMs = opts?.timeoutMs ?? QUERY_EXPANSION_DEFAULTS.timeoutMs;
  if (ttlMs > 0) {
    const hit = expansionCache.get(query);
    if (hit && Date.now() - hit.at < ttlMs) return hit.terms;
    if (hit) expansionCache.delete(query); // 过期
  }
  let raw: string;
  try {
    raw = await runner.run({
      prompt: buildExpansionPrompt(query),
      taskId: EXPANSION_TASK_ID,
      timeoutMs,
      maxTokens: QUERY_EXPANSION_MAX_TOKENS_OVERRIDE,
    });
  } catch (err) {
    warnOnce(opts?.logger, `query expansion LLM call failed (non-fatal, no expansion): ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
  const terms = parseExpansion(raw, { maxTerms: opts?.maxTerms, original: query });
  if (terms.length === 0) return [];
  if (ttlMs > 0) {
    expansionCache.set(query, { terms, at: Date.now() });
    if (expansionCache.size > EXPANSION_CACHE_MAX) {
      const oldest = expansionCache.keys().next().value;
      if (oldest !== undefined) expansionCache.delete(oldest);
    }
  }
  return terms;
}

let expansionWarned = false;
function warnOnce(logger: Logger | undefined, msg: string): void {
  if (expansionWarned) return;
  expansionWarned = true;
  logger?.warn?.(`[memory-tdai][query-expand] ${msg}`);
}

// ── E1.3 FTS OR 合并（纯函数）──

/**
 * E1.3：扩展词以 OR 并入 FTS MATCH 表达式（`(原词) OR (词1) OR (词2)…`）。
 * 原词在前（BM25 相关度权重不因扩展扰动首位）；扩展词 strip 引号、trim、
 * 与既有 token 去重（大小写不敏感）；ftsQuery 为 null 且无有效扩展词 → null。
 * 向量路不消费本函数（语义相似已处理改写——E1.3）。
 */
export function mergeFtsQueryWithExpansion(
  ftsQuery: string | null | undefined,
  terms?: readonly string[],
): string | null {
  const tokens: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string): void => {
    const t = raw.replaceAll('"', "").trim();
    if (!t) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    tokens.push(t);
  };
  if (ftsQuery) {
    for (const part of ftsQuery.split(" OR ")) push(part);
  }
  for (const term of terms ?? []) push(term);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

// ── standalone runner 惰性构造（C2 derive 模式：resolveStandaloneLlmForRuntime + StandaloneLLMRunner）──

/**
 * LLM 配置最小面（MemoryTdaiConfig["llm"] 的字集；gateway loader 已填充 provider/proxy）。
 */
export interface QueryExpansionLlmConfig {
  enabled?: boolean;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
  provider?: "openai" | "proxy";
  proxy?: { useMemorySystemUserKey?: boolean };
  stream?: boolean;
}

type RunnerState = ExpansionRunner | null | undefined;
/** 进程级缓存（undefined=未尝试 / null=构造失败哨兵——避免每个请求重复尝试，C2 同款）。 */
let expansionRunnerState: RunnerState;

/**
 * 惰性构造查询扩展 runner（C2 derive 模式同源：env/config 同源解析 + StandaloneLLMRunner）。
 * llm 未配 baseUrl / apiKey 为空 / enabled=false / 构造失败 → undefined（引擎一退化关——
 * E1.4，零影响）。apiKey 空 = 未配置：parseConfig 的 baseUrl 缺省指向 api.openai.com，
 * 空钥匙必然 401/挂起——宁缺毋滥，不做注定失败的外呼（recall 热路径无重试预算）。
 * 构造时不覆写 maxTokens——覆写在 run() 调用点（QUERY_EXPANSION_MAX_TOKENS_OVERRIDE，
 * 推理模型预算教训的生效位置与 C2/DISC 一致）。
 */
export async function resolveQueryExpansionRunner(
  llm?: QueryExpansionLlmConfig | null,
  instanceId?: string,
  logger?: Logger,
): Promise<ExpansionRunner | undefined> {
  if (expansionRunnerState !== undefined) return expansionRunnerState ?? undefined;
  try {
    if (llm?.enabled === false || !llm?.baseUrl || !llm.apiKey) {
      expansionRunnerState = null;
      return undefined;
    }
    const { StandaloneLLMRunner } = await import("../../adapters/standalone/llm-runner.js");
    const { resolveStandaloneLlmForRuntime } = await import("../../adapters/standalone/llm-provider-resolver.js");
    const effective = resolveStandaloneLlmForRuntime(llm as never, instanceId ?? "default");
    expansionRunnerState = new StandaloneLLMRunner({
      config: {
        baseUrl: effective.baseUrl,
        apiKey: effective.apiKey,
        model: effective.model ?? "default",
        timeoutMs: effective.timeoutMs ?? 120_000,
        stream: effective.stream ?? false,
      },
    }) as unknown as ExpansionRunner;
  } catch (err) {
    logger?.warn?.(
      `[memory-tdai][query-expand] LLM runner not available (expansion off): ${err instanceof Error ? err.message : String(err)}`,
    );
    expansionRunnerState = null;
  }
  return expansionRunnerState ?? undefined;
}
