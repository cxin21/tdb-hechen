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
  /**
   * R71-A1（2026-10-19）：FTS5 raw relevance（=-rank，越大越相关）——work_fact 候选
   * bm25 预地板（conclusionLayer.minBm25Rel）数据源。scene_block 源 / 后端未提供 rank
   * 的行 = undefined = 地板豁免（宁缺毋滥不误杀）。
   */
  bm25Rel?: number;
}

export type L2Conclusion = L2ConclusionCandidate;

/** 命中判定输入（query 分词——buildFtsQuery 单一源产物的 token 集）。 */
export interface L2MatchInputs {
  ftsTokens: readonly string[];
  /**
   * v18-c（何晨拍板「全做」2026-10-05）：结论块低密度门——句子级去重保留率下限（0-1）。
   * undefined/0 = 关（逐位现状）。低密度 = 自指回放块（同一句式高频重复）占满 halfLimit
   * 配额（v18 取证：10236 字「同源再交付无新增仅维护热度」块吃满 2 块全部结论层名额）。
   * 门不过的候选跳过、选择器继续取下一名（宁缺毋滥 + 让位语义）。
   */
  minUniqRatio?: number;
  /**
   * P1（issue #2 词面匹配器过宽，2026-10-13）：textHit 万词面 token 剔除——batch
   * 相对 IDF 门。token 命中候选占比 > 此值（0-1）= 万词面通用 token，从 textHit
   * 匹配集剔除（sceneHit 不受影响）。undefined/0 = 关 = 逐位现状。纯函数、确定性：
   * IDF 分母 = 本轮传入的候选集（已在调用点按 query 收窄），非全库统计。
   */
  textHitMaxTokenRatio?: number;
  /**
   * #53（2026-10-19）：L2 结论层 textHit IDF 加权排序（缺省 off = 逐位现状）。
   * true 时同 source 层内按 batch 相对 IDF 分（conclusionIdfScores，对 matchTokens
   * 计分）降序稳定重排——稀有 token 命中者先于万词面命中者；层级序（work_fact 先于
   * scene_block）与调用方序（平分保序）不变。纯确定性：无时钟、无随机。
   */
  idfWeighted?: boolean;
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
 * #53（2026-10-19）：L2 textHit 升级 batch 相对 IDF 加权计分——token 命中候选占比越低
 * （越稀有）权重越高：idf(t) = ln(1 + N / (1 + df(t)))。df 分母 = 本轮传入候选集（与
 * P1 万词面剔除门同一 batch 相对语义，非全库统计）；1 字 token 不计分（与 textHit
 * 匹配集同门槛）；sceneHit 不计分（加权只作用于 textHit 通道）。确定性纯函数。
 */
export function conclusionIdfScores(
  candidates: readonly L2ConclusionCandidate[],
  tokens: readonly string[],
): number[] {
  const n = candidates.length;
  if (n === 0) return [];
  const lowerContents = candidates.map((c) =>
    typeof c?.content === "string" ? c.content.toLowerCase() : "",
  );
  const usable = tokens
    .filter((t) => typeof t === "string" && t.length >= 2)
    .map((t) => t.toLowerCase());
  const idfs = usable.map((lt) => {
    let df = 0;
    for (const lc of lowerContents) if (lc.includes(lt)) df++;
    return Math.log(1 + n / (1 + df));
  });
  return lowerContents.map((lc) => {
    let s = 0;
    for (let i = 0; i < usable.length; i++) if (lc.includes(usable[i])) s += idfs[i];
    return s;
  });
}

/**
 * v18-c · 结论块信息密度（句子级去重保留率）：按句末标点/换行分句 → 归一化（trim+去全部空白）
 * → unique/total。句数 ≤2 = 1（块太小不判，防误杀）。确定性纯函数。
 * 背景（v18 取证）：低密度自指回放块（同一句式高频重复，如「同源再交付无新增仅维护热度」
 * 10236 字块）占满 halfLimit 结论层配额。
 */
export function conclusionUniqRatio(content: string): number {
  if (typeof content !== "string") return 1;
  const sentences = content
    .split(/[。！？；!?\n]+/)
    .map((s) => s.trim().replace(/\s+/g, ""))
    .filter((s) => s.length > 0);
  if (sentences.length <= 2) return 1;
  return new Set(sentences).size / sentences.length;
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
  // P1（issue #2 词面匹配器过宽）：batch 相对 IDF——token 命中候选占比 > 阈值的
  // 万词面 token（"项目""工作"级通用词）不参与 textHit 判定（sceneHit 不受影响）。
  // 未配置/0 = 关 = 逐位现状（matchTokens 即原 tokens，行为逐位一致）。
  // 对抗审查修复（#5 major）：work_fact 候选经 buildFtsQuery(query) FTS 预筛，候选集
  // 内 token 占比天然≈1——若全部 token 都被判为万词面（过滤后为空），回落原 token
  // 集（保持 FTS 预筛通道现状），避免该通道被门静默清空。
  const ratioGate = inputs?.textHitMaxTokenRatio;
  let matchTokens = tokens;
  if (ratioGate != null && ratioGate > 0 && candidates.length > 0) {
    const lowerCandidates = candidates.map((c) =>
      typeof c?.content === "string" ? c.content.toLowerCase() : "",
    );
    const isCommon = (t: string): boolean => {
      const lt = t.toLowerCase();
      let hits = 0;
      for (const lc of lowerCandidates) if (lc.includes(lt)) hits++;
      return hits / candidates.length > ratioGate;
    };
    const gated = tokens.filter((t) => t.length >= 2 && !isCommon(t));
    if (gated.length > 0) matchTokens = gated;
  }
  const rankOf = (c: L2ConclusionCandidate): number => (c.source === "work_fact" ? 0 : 1);
  // #53：IDF 加权（缺省 off = 逐位现状——不额外计算分数）
  const idfOn = inputs?.idfWeighted === true;
  const idfScores = idfOn ? conclusionIdfScores(candidates, matchTokens) : [];
  const seen = new Set<string>();
  const out: { c: L2Conclusion; i: number; score: number }[] = [];
  let idx = -1;
  for (const c of candidates) {
    idx++;
    if (out.length >= limit) break;
    if (!c || typeof c.content !== "string" || c.content.trim().length === 0) continue;
    const sceneHit = c.sceneName ? detectSceneHit(query, [c.sceneName]) : null;
    if (!sceneHit && !textHit(c.content, matchTokens)) continue;
    // v18-c：低密度自指回放块跳过（取下一名候选 = 让位语义；undefined/0 = 关，逐位现状）
    if (
      inputs.minUniqRatio != null &&
      inputs.minUniqRatio > 0 &&
      conclusionUniqRatio(c.content) < inputs.minUniqRatio
    ) {
      continue;
    }
    const key = `${c.sceneName}\u0000${c.content}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ c: { sceneName: c.sceneName, content: c.content, source: c.source, recordId: c.recordId }, i: idx, score: idfOn ? (idfScores[idx] ?? 0) : 0 });
  }
  // work_fact 优先（稳定结论 > 场景块摘要）；#53 开启时同层内按 IDF 分降序（稀有 token
  // 命中者先于万词面命中者），平分回落调用方序——稳定排序。off = 逐位现状。
  return out
    .sort((a, b) => {
      const layer = rankOf(a.c) - rankOf(b.c);
      if (layer !== 0) return layer;
      if (idfOn && a.score !== b.score) return b.score - a.score;
      return a.i - b.i;
    })
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
 * Batch B F2（2026-10-20 · issue #76）：句界版结论截断——按句累积（。！？；\n 为界、
 * 保留分隔符），预算内整句保留、装不下的下一句起整句舍弃 + 尾部同款 `…[截断:原文N字]`
 * 标注（N=原文全码点长，标注计入预算，结果 ≤ maxChars）。首句即超预算（或标注放不下）
 * → 退化为 truncateConclusionContent 同输出（码点截断语义不回退）。透传守卫与 chars 版
 * 一致：非 string/空、maxChars<=0/非有限 → 原样返回（通道关闭）。
 */
export function truncateConclusionContentSentences(content: string, maxChars: number): string {
  if (typeof content !== "string" || content.length === 0) return content;
  if (!Number.isFinite(maxChars) || maxChars <= 0) return content;
  const limit = Math.floor(maxChars);
  const cps = Array.from(content);
  if (cps.length <= limit) return content;
  const sentences = content.match(/[\s\S]*?[。！？；\n]|[\s\S]+$/g) ?? [];
  const marker = `…[截断:原文${cps.length}字]`;
  const markerLen = Array.from(marker).length;
  const kept: string[] = [];
  let keptLen = 0;
  for (const s of sentences) {
    const len = Array.from(s).length;
    if (keptLen + len > limit) break;
    kept.push(s);
    keptLen += len;
  }
  if (kept.length === 0 || keptLen + markerLen > limit) {
    return truncateConclusionContent(content, maxChars); // 退化：与 chars 模式同输出
  }
  return kept.join("").trimEnd() + marker;
}

/**
 * Batch B F2（2026-10-20 · issue #76）：结论行总预算分配——
 * perLine = floor(min(maxTotalChars/count, maxCharsPerMemory))。
 * maxTotalChars 缺省/非有限/<=0（关）或 count 非有限/<=0 → 返回 maxCharsPerMemory
 * （= 逐位现状，无总预算约束）；充足预算帽不放大（min 兜底不超单行帽）。
 */
export function allocateConclusionPerLineChars(
  count: number,
  maxTotalChars: number | undefined,
  maxCharsPerMemory: number,
): number {
  const total =
    typeof maxTotalChars === "number" && Number.isFinite(maxTotalChars) && maxTotalChars > 0
      ? Math.floor(maxTotalChars)
      : undefined;
  if (total === undefined || !(Number.isFinite(count) && count > 0)) return maxCharsPerMemory;
  return Math.min(maxCharsPerMemory, Math.floor(total / Math.floor(count)));
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
