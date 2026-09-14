/**
 * /v3/admin/credit-pricing — 价目表运行时管理（spec §9，复刻 rate-limits 模式）。
 * yaml 为底，storage override 整表替换；PUT/DELETE 直接热替换共享 config.creditPricing
 * （handlers 每请求读该对象 → 下一请求生效）。内网信任模型，与 rate-limits 一致。
 */
import type { Context } from "hono";
import type { ProxyConfig, CreditPricingEntry } from "../types.js";
import { getProxyStorage } from "../storage/factory.js";

/**
 * 持久化键 —— 对齐 member-llm/provider-repo.ts 的 keyOf 约定：
 * `nottl/<namespace>/<dir>/<name>.json`。nottl bucket 永不过期（丢 override 会
 * 静默回退 yaml 底表，与 provider-repo 同理由），`_default` namespace 表示全局。
 * brief 里的 "admin:credit-pricing" 冒号风格在 fs 后端（Windows 文件名）不合法，
 * 故适配为路径风格。
 */
export const CREDIT_PRICING_STORAGE_KEY = "nottl/_default/admin/credit-pricing.json";

const PRICE_FIELDS = ["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"] as const;

/**
 * yaml 底表 —— 模块级捕获（而非 handler 创建时快照）。
 * 启动链路是 index.ts 先 `await applyStoredCreditPricing(config)`（热替换成 storage
 * override）后 `createApp(config)` → createCreditPricingHandlers；若在 handler 创建时
 * 快照，捕获到的是 override 而非 yaml 底表，DELETE 会把 override 冒充 yaml 静默恢复。
 * 故 applyStoredCreditPricing 在热替换**之前**捕获此刻仍是 yaml 底表的 config；
 * 未应用 override 的进程内（如单测直建 handlers）config 上本就是 yaml 底表，语义不变。
 */
let yamlBaseModels: CreditPricingEntry[] | null = null;

/** 测试隔离钩子：清空模块级底表，避免用例间底表泄漏。 */
export function __resetCreditPricingBaseForTests(): void {
  yamlBaseModels = null;
}

function storageOf(config: ProxyConfig) {
  return getProxyStorage(config.storage);
}

export async function applyStoredCreditPricing(config: ProxyConfig): Promise<void> {
  // 此刻 config.creditPricing 上还是 yaml 底表 —— 先捕获，再热替换（置于 try 外：
  // 即使存储工厂/读取抛异常，底表捕获也不可跳过）
  yamlBaseModels = config.creditPricing?.models ?? [];
  try {
    const stored = await storageOf(config).getJSON<CreditPricingEntry[]>(CREDIT_PRICING_STORAGE_KEY);
    if (stored?.length) config.creditPricing = { models: stored };
  } catch { /* 存储不可用 → 维持 yaml 底表 */ }
}

export function createCreditPricingHandlers(config: ProxyConfig) {
  return {
    get: (c: Context) => handleGet(c, config),
    put: (c: Context) => handlePut(c, config),
    delete: (c: Context) => handleDelete(c, config),
  };
}

/** yaml 底表解析：override 已应用（模块级捕获存在）用捕获值，否则 config 上就是 yaml 底表。 */
function yamlBaseOf(config: ProxyConfig): CreditPricingEntry[] {
  return yamlBaseModels ?? config.creditPricing?.models ?? [];
}

async function handleGet(c: Context, config: ProxyConfig): Promise<Response> {
  const stored = await storageOf(config).getJSON<CreditPricingEntry[]>(CREDIT_PRICING_STORAGE_KEY).catch(() => null);
  const models = stored?.length ? stored : yamlBaseOf(config);
  return ok(c, { source: stored?.length ? "override" : "yaml", models });
}

async function handlePut(c: Context, config: ProxyConfig): Promise<Response> {
  const parsed = await parseBody(c);
  if (parsed instanceof Response) return parsed;
  const v = validateModels(parsed?.models);
  if (typeof v === "string") return error(c, 400, v);
  // 懒捕获兜底：进程内未走启动链路（applyStoredCreditPricing 未执行）时，
  // 在热替换前把此刻的 yaml 底表登记下来，否则 PUT 之后的 DELETE 会把
  // override 冒充 yaml 静默恢复。启动链路下 yamlBaseModels 已有值，??= 无副作用。
  yamlBaseModels ??= config.creditPricing?.models ?? [];
  await storageOf(config).putJSON(CREDIT_PRICING_STORAGE_KEY, v);
  config.creditPricing = { models: v }; // 热生效（下一请求读取新引用）
  return ok(c, { source: "override", models: v });
}

async function handleDelete(c: Context, config: ProxyConfig): Promise<Response> {
  const yamlModels = yamlBaseOf(config);
  await storageOf(config).del(CREDIT_PRICING_STORAGE_KEY).catch(() => undefined);
  config.creditPricing = { models: yamlModels };
  return ok(c, { source: "yaml", models: yamlModels, deleted: true });
}

/** 校验整表；合法返回 entries，非法返回错误消息。 */
function validateModels(raw: unknown): CreditPricingEntry[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return "models 必须是非空数组";
  const seen = new Set<string>();
  for (const e of raw) {
    const entry = e as Record<string, unknown>;
    if (typeof entry.name !== "string" || !entry.name.trim()) return "每条 name 必须是非空字符串";
    if (typeof entry.modelName !== "string" || !entry.modelName.trim()) return "每条 modelName 必须是非空字符串";
    const key = entry.modelName.toLowerCase();
    if (seen.has(key)) return `modelName 重复: ${entry.modelName}`;
    seen.add(key);
    for (const f of PRICE_FIELDS) {
      const n = entry[f];
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return `${entry.modelName}.${f} 必须是 >=0 的数值`;
    }
  }
  return raw as CreditPricingEntry[];
}

async function parseBody(c: Context): Promise<Record<string, unknown> | Response> {
  try { return await c.req.json<Record<string, unknown>>(); }
  catch { return error(c, 400, "invalid JSON body"); }
}

function ok(c: Context, data: Record<string, unknown>): Response {
  return c.json({ code: 0, message: "ok", data });
}
function error(c: Context, status: 400 | 503, message: string): Response {
  return c.json({ code: status, message }, status);
}
