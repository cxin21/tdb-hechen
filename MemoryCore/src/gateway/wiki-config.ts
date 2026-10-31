/**
 * task-73（core wiki 薄转发）· 运行配置解析
 *
 * 权威来源 yaml `memory.wiki.*`（已在 src/config.ts 解析为 WikiForwardConfig）。
 * 本模块只做两件事：
 *   1. 给出缺省值常量（与 config.ts 的缺省保持一处真理）；
 *   2. 允许**运维 env 覆盖**，用于灰度/应急，不必改 yaml 重启整栈。
 *
 * env 一览（全部可选）：
 *   TDB_WIKI_ENABLED=true|false
 *   TDB_WIKI_BASE_URL=http://127.0.0.1:8421
 *   TDB_WIKI_SERVICE_ID=default
 *   TDB_WIKI_TEAM_VERIFY=off|warn|enforce
 *   TDB_WIKI_TIMEOUT_MS=2500
 *   TDB_WIKI_PER_WIKI_TIMEOUT_MS=2000
 *   TDB_WIKI_TOP_K=6
 *   TDB_WIKI_MIN_SCORE=0.02
 *
 * 铁律（与 config.ts 一致）：解析**永不抛**。非法值一律回落缺省 —— 这条端点的
 * 可用性优先于配置严格性，一个写错的 env 不该让 /v3/wiki/* 直接 500。
 */
import type { WikiForwardConfig, WikiTeamVerifyMode } from "../config.js";

export const DEFAULT_WIKI_FORWARD_CONFIG: WikiForwardConfig = {
  enabled: true,
  baseUrl: "http://127.0.0.1:8421",
  serviceId: "default",
  timeoutMs: 2500,
  perWikiTimeoutMs: 2000,
  perWikiLimit: 4,
  topK: 6,
  minScore: 0.02,
  maxWikis: 8,
  concurrency: 4,
  teamVerify: "enforce",
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

const parseFinite = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined;
  const n = Number(raw.trim());
  return Number.isFinite(n) ? n : undefined;
};

const parseBool = (raw: string | undefined): boolean | undefined => {
  if (raw === undefined) return undefined;
  const s = raw.trim().toLowerCase();
  if (s === "1" || s === "true" || s === "yes" || s === "on") return true;
  if (s === "0" || s === "false" || s === "no" || s === "off") return false;
  return undefined;
};

const parseMode = (raw: string | undefined): WikiTeamVerifyMode | undefined => {
  if (raw === undefined) return undefined;
  const s = raw.trim().toLowerCase();
  return s === "off" || s === "warn" || s === "enforce" ? s : undefined;
};

/**
 * 把 config.ts 解析出的 WikiForwardConfig（可能是旧 yaml，缺字段）叠上 env 覆盖，
 * 产出**全字段就绪**的配置。任何缺字段都用缺省补齐，因此上游传 undefined 也安全。
 */
export function resolveWikiForwardConfig(
  input?: Partial<WikiForwardConfig> | null,
  env: Record<string, string | undefined> = process.env,
): WikiForwardConfig {
  const merged: WikiForwardConfig = { ...DEFAULT_WIKI_FORWARD_CONFIG, ...(input ?? {}) };

  const enabled = parseBool(env.TDB_WIKI_ENABLED);
  const baseUrl = env.TDB_WIKI_BASE_URL?.trim();
  const serviceId = env.TDB_WIKI_SERVICE_ID?.trim();
  const mode = parseMode(env.TDB_WIKI_TEAM_VERIFY);
  const timeoutMs = parseFinite(env.TDB_WIKI_TIMEOUT_MS);
  const perWikiTimeoutMs = parseFinite(env.TDB_WIKI_PER_WIKI_TIMEOUT_MS);
  const topK = parseFinite(env.TDB_WIKI_TOP_K);
  const minScore = parseFinite(env.TDB_WIKI_MIN_SCORE);

  return {
    enabled: enabled ?? merged.enabled !== false,
    baseUrl: (baseUrl || merged.baseUrl || DEFAULT_WIKI_FORWARD_CONFIG.baseUrl).replace(/\/+$/, ""),
    serviceId: serviceId || merged.serviceId || DEFAULT_WIKI_FORWARD_CONFIG.serviceId,
    timeoutMs: clamp(timeoutMs ?? merged.timeoutMs, 100, 10_000),
    perWikiTimeoutMs: clamp(perWikiTimeoutMs ?? merged.perWikiTimeoutMs, 100, 10_000),
    perWikiLimit: Math.floor(clamp(merged.perWikiLimit, 1, 20)),
    topK: Math.floor(clamp(topK ?? merged.topK, 1, 20)),
    minScore: clamp(minScore ?? merged.minScore, 0, 10),
    maxWikis: Math.floor(clamp(merged.maxWikis, 1, 16)),
    concurrency: Math.floor(clamp(merged.concurrency, 1, 8)),
    teamVerify: mode ?? merged.teamVerify ?? DEFAULT_WIKI_FORWARD_CONFIG.teamVerify,
  };
}
