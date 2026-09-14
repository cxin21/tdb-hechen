/**
 * R7 渐进式披露分层召回（DS-RECALL-LAYERED-R7-001）——L2 结论层选择 + 预算切分 + 注入组装纯函数。
 *
 * 两层模型（spec §1）：
 *   第一层 · L2 结论（常驻、稳定、cache 友好）：场景持续态结论（consolidation 产物
 *   durative work_fact + scene blocks title+snippet 通道），按 query→scene 命中选择；
 *   第二层 · L1 经验（按预算折叠，九通道照常）。
 *
 * 不变式（spec §3）：
 *   1. 九通道/绝对门槛/租户隔离/降级标注零变化——本模块不改任何检索排序语义；
 *   2. 无 L2 命中 → 与现状逐位一致（退化安全：conclusionLines 为空时全链恒等）；
 *   3. 幂等（spec §2 R7-1，借团队 幂等与防重 模式）：结论未变化的场景不重组注入
 *     （命中已存不重组——resolveIdempotentConclusionLines 复用已存行）。
 *
 * 确定性：命中判定只依赖 query/候选文本与调用方传入 token 集，无时钟、无随机。
 */
import { detectSceneHit } from "../tools/recall-signals.js";

export type L2ConclusionSource = "work_fact" | "scene_block";

/** L2 结论候选（work_fact 行 / scene block title+snippet 归一形状）。 */
export interface L2ConclusionCandidate {
  /** 场景名（scene_name 命中检测源；空串 = 仅文本命中通道）。 */
  sceneName: string;
  /** 结论文本（work_fact content / scene block summary）。 */
  content: string;
  source: L2ConclusionSource;
  /** work_fact 源的 record id（part_of 证据链反查 + 经验层防重排除源）。 */
  recordId?: string;
}

export type L2Conclusion = L2ConclusionCandidate;

/** 命中判定输入（query 分词——buildFtsQuery 单一源产物的 token 集）。 */
export interface L2MatchInputs {
  ftsTokens: readonly string[];
}

/**
 * 从 buildFtsQuery 产物提取 token 集（单一源：不重写分词，仅解析其 OR 引号形态）。
 * buildFtsQuery 返回 `"t1" OR "t2"`（或 null）——本函数逆向还原 token 数组。
 */
export function parseFtsTokens(ftsQuery: string | null | undefined): string[] {
  if (!ftsQuery) return [];
  return ftsQuery
    .split(" OR ")
    .map((t) => t.replaceAll('"', "").trim())
    .filter((t) => t.length > 0);
}

/** 文本命中：token（≥2 字符，防单字噪声）大小写不敏感子串命中结论文本。 */
function textHit(content: string, ftsTokens: readonly string[]): boolean {
  const lower = content.toLowerCase();
  return ftsTokens.some((t) => t.length >= 2 && lower.includes(t.toLowerCase()));
}

/**
 * R7-1 · L2 结论层选择（纯函数、确定性、宁缺毋滥）。
 *
 * 命中判定（沿既有单一源逻辑）：
 *   - scene_name 命中：detectSceneHit(query, [sceneName]) 非空（含层级祖先段语义）；
 *   - 文本命中：query token（≥2 字符）为结论文本子串。
 *   二者任一即命中；二者皆无 → 不选（宁缺毋滥）。
 * 排序：work_fact（持续态）先于 scene_block，同层保持调用方顺序（FTS BM25 序 / scene index 序）；
 * 去重：sceneName+content 完全相同只保留一条（幂等与防重：命中已存不重复）；
 * 上限：截断到 limit（预算对半的结论侧额度，由调用方传入）。
 */
export function selectL2Conclusions(
  query: string,
  candidates: readonly L2ConclusionCandidate[],
  inputs: L2MatchInputs,
  limit: number,
): L2Conclusion[] {
  if (!query || query.trim().length === 0) return [];
  if (!candidates || candidates.length === 0) return [];
  if (!(limit > 0)) return [];
  const tokens = inputs?.ftsTokens ?? [];
  const rankOf = (c: L2ConclusionCandidate): number => (c.source === "work_fact" ? 0 : 1);
  const seen = new Set<string>();
  const out: L2Conclusion[] = [];
  for (const c of candidates) {
    if (out.length >= limit) break;
    if (!c || typeof c.content !== "string" || c.content.trim().length === 0) continue;
    const sceneHit = c.sceneName ? detectSceneHit(query, [c.sceneName]) : null;
    if (!sceneHit && !textHit(c.content, tokens)) continue;
    const key = `${c.sceneName}\u0000${c.content}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ sceneName: c.sceneName, content: c.content, source: c.source, recordId: c.recordId });
  }
  // work_fact 优先（稳定结论 > 场景块摘要），同层保序——稳定排序
  return out
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rankOf(a.c) - rankOf(b.c) || a.i - b.i)
    .map(({ c }) => c);
}

/** 预算切分结果（spec §1：注入 limit 对半；结论不足时余额给经验层）。 */
export interface LayeredBudget {
  conclusionLimit: number;
  experienceLimit: number;
}

/**
 * R7-1/R7-2 · 预算对半切：结论层额度 = min(结论数, floor(total/2))，
 * 经验层 = total − 结论层（结论不足时余额自动给经验层）。total<=0 → 全 0。
 */
export function splitBudget(totalLimit: number, conclusionCount: number): LayeredBudget {
  const total = Number.isFinite(totalLimit) && totalLimit > 0 ? Math.floor(totalLimit) : 0;
  const half = Math.floor(total / 2);
  const count = Number.isFinite(conclusionCount) && conclusionCount > 0 ? Math.floor(conclusionCount) : 0;
  const conclusionLimit = Math.min(count, half);
  return { conclusionLimit, experienceLimit: total - conclusionLimit };
}

/**
 * Task CAL C1 · 结论层注入前截断（brief 裁决：selectL2Conclusions 产出后、注入前，
 * 按 conclusionLayer.maxCharsPerMemory 截断（默认 2000 字符/块）+ 尾部 `…[截断:原文N字]` 标注。
 *
 * 修首跑 F1（DS-EVAL-LAYERED-001）：巨型场景块摘要（TDB团队-技术架构文档 21,660 字符）
 * 无截断注入 → 万词面通用匹配器（任何 query 的 ≥2 字 token 都子串命中）→ CC/CTR 失去区分度。
 *
 * 纪律（brief）：纯注入层截断——不碰绝对门槛、不碰九通道排序逻辑（R7 不变式 §3.1 零变化）；
 * maxChars<=0 / 非有限数 = 通道关闭（不截断）；码点安全（surrogate 不劈半，沿既有
 * truncateRecallLine 的 Array.from 模式）；标注计入 maxChars 预算（结果 ≤ maxChars）。
 */
export function truncateConclusionContent(content: string, maxChars: number): string {
  if (typeof content !== "string" || content.length === 0) return content;
  if (!Number.isFinite(maxChars) || maxChars <= 0) return content; // 0=不截断（通道关闭）
  const limit = Math.floor(maxChars);
  const cps = Array.from(content);
  if (cps.length <= limit) return content;
  const marker = `…[截断:原文${cps.length}字]`;
  const markerLen = Array.from(marker).length;
  if (limit <= markerLen) {
    return cps.slice(0, limit).join(""); // 退化：预算不足以容纳标注 → 纯码点截断不标注
  }
  return cps.slice(0, limit - markerLen).join("").trimEnd() + marker;
}

/**
 * R7-3 · 结论行格式（带 [结论] 标注，spec §2 R7-3）：`- [结论|场景名] 内容`；
 * 无场景名 → `- [结论] 内容`。保持行首 `- [tag] content` 结构（metric 解析正则兼容）。
 */
export function formatConclusionLine(c: L2Conclusion): string {
  const tag = c.sceneName ? `结论|${c.sceneName}` : "结论";
  return `- [${tag}] ${c.content}`;
}

/**
 * R7-3 · 注入组装：结论块在前 + 经验折叠在后（现状标注体系保留）。
 * 无结论 → 返回经验序列的等值副本（逐位一致，退化安全）。
 */
export function assembleLayeredLines(
  conclusionLines: readonly string[],
  experienceLines: readonly string[],
): string[] {
  return [...conclusionLines, ...experienceLines];
}

/**
 * 幂等指纹：结论集序列化（顺序敏感——选择器输出本身确定性）。
 */
export function conclusionFingerprint(conclusions: readonly L2Conclusion[]): string {
  return JSON.stringify(
    conclusions.map((c) => ({ s: c.sceneName, c: c.content, r: c.source, id: c.recordId ?? "" })),
  );
}

// ── 幂等结论层缓存（E3 会话复用同款原则：TTL 漂移防御 + 200 上界防膨胀）──

interface ConclusionCacheEntry {
  fingerprint: string;
  lines: string[];
  at: number;
}
const conclusionCache = new Map<string, ConclusionCacheEntry>();
const CONCLUSION_CACHE_MAX = 200;

/**
 * R7-1 幂等结论层：同 session 同指纹 → 复用已存行（不重组——cache 友好）；
 * 指纹变化 / TTL 过期 / ttl<=0（通道关）/ 无 sessionKey → 返回 fresh 行并落缓存。
 *
 * 审查修补 I③（缓存友好兑现）：命中复用时刷新插入序（refresh-on-hit，Map 迭代序 =
 * 插入序——热 session 不再被 FIFO 逐出）；`at` 不刷新——TTL 仍锚定首次写入，
 * 防"持续命中 → 永久驻留"的漂移窗口失效。
 */
export function resolveIdempotentConclusionLines(
  sessionKey: string,
  fingerprint: string,
  freshLines: string[],
  ttlMs: number,
  now: number = Date.now(),
): { lines: string[]; reused: boolean } {
  if (ttlMs > 0 && sessionKey) {
    const hit = conclusionCache.get(sessionKey);
    if (hit && hit.fingerprint === fingerprint && now - hit.at < ttlMs) {
      // refresh-on-hit：删除后重插 = 移到迭代序末尾（FIFO 逐出让位给热键）
      conclusionCache.delete(sessionKey);
      conclusionCache.set(sessionKey, hit);
      return { lines: hit.lines, reused: true };
    }
    conclusionCache.set(sessionKey, { fingerprint, lines: freshLines, at: now });
    if (conclusionCache.size > CONCLUSION_CACHE_MAX) {
      const oldest = conclusionCache.keys().next().value;
      if (oldest !== undefined) conclusionCache.delete(oldest);
    }
    return { lines: freshLines, reused: false };
  }
  return { lines: freshLines, reused: false };
}
