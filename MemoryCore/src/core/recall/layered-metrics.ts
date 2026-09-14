/**
 * 分层评估框架 · 三指标纯函数（Task E1，DS-EVAL-LAYERED-001 实施）。
 *
 * 设计权威：td-agemem/docs/superpowers/specs/2026-09-11-layered-recall-evaluation-design.md
 *   §2.1 CC（结论覆盖率）· §2.2 CTR/ALD（信息密度两分量）· §2.3 SD（来源多样性分布 + Shannon 熵）
 *   §2.4 三指标均为观测性指标（首版只建基线，不设验收门）。
 *
 * 性质纪律（与 recall-layered.ts 同款）：
 *   - 纯函数、确定性、零 IO（IO 在 eval-layered-recall.ts 脚本层）——无时钟、无随机、无副作用；
 *   - 单一实现（P-A 铁律）：CC 判定复用 detectSceneHit（场景命中单一源）；
 *   - 不与 P@5 合成任何单一分数（spec §4.2 不合并不互判）。
 *
 * 口径登记（实现裁决，报告须与之一致）：
 *   - 字符口径：CTR/ALD 按注入行全行字符数（含 `- [tag]` 标注——标注是注入块真实组成）；
 *   - token 口径：非 ASCII（CJK 为主）1 字 1 token、ASCII 4 字 1 token（ceil）——固定口径，
 *     比较意义大于绝对意义；首版仅作辅助字段（IR 分量三待权重校准后启用，本文件不合成）；
 *   - CC'（条件口径）分母 = 结论层非空的 query 数；分母为 0 时返回 null（不伪造）。
 */
import { detectSceneHit } from "../tools/recall-signals.js";

// ============================
// token 估算（spec §2.2 固定口径）
// ============================

/**
 * token 估算：非 ASCII 字符（CJK 及全角标点）1 字 1 token；ASCII 字符 4 字 1 token（ceil）。
 * 空串 → 0。固定口径，比较意义大于绝对意义（不追求精确 tokenizer）。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let cjk = 0;
  for (const ch of text) {
    if (ch.codePointAt(0)! <= 0x7f) ascii++;
    else cjk++;
  }
  return cjk + Math.ceil(ascii / 4);
}

// ============================
// SD · 来源分类（spec §2.3，与注入行标注体系一一对应）
// ============================

/** 注入行来源分类（spec §2.3 五类，键名即报告口径）。 */
export type SdCategory = "L2结论" | "L1九通道" | "scene补池" | "value补池" | "graph补池";

export const SD_CATEGORIES: readonly SdCategory[] = ["L2结论", "L1九通道", "scene补池", "value补池", "graph补池"];

/**
 * 单行来源分类（按行标注解析，与现有标注体系一一对应）：
 *   - `L2结论`：行首 `- [结论]` / `- [结论|场景名]`（formatConclusionLine 产物）；
 *   - `scene补池`：行尾标注 `[scene:名]`（R7-2 scene 反查补池；formatMemoryLine 恒以
 *     ` ·[recall_channel]` 收尾）；
 *   - `value补池`：行尾标注 `[value:锚]`（R-A2 价值反查补池）；
 *   - `graph补池`：行尾标注 `[graph:...]` / `[graph:ppr:kind]`（V2-1 PPR 图扩散）；
 *   - `L1九通道`：以上皆无的经验行（episodic / work_fact 等主检索行；含 [explore] 探索位——
 *     explore 不属 spec §2.3 补池标注体系，归主检索行）。
 * 判定顺序与口径（实现裁决，报告与单测一致）：
 *   - 结论行优先（防结论文本内出现标注字样误判）；
 *   - 补池通道判定 = 行尾 `·[channel]` 形态（formatMemoryLine 追加通道标注的同款分隔符
 *     ` ·[recall_channel]`，行尾锚定）——正文引用的 `[graph:...]` 等字样（如记忆内容转述
 *     标注体系）不是通道标注，不参与分类（防正文引用误判——单测 B12/B13 钉死）。
 *   - 残余边界：正文恰以 `·[graph:...]` 形态字样收尾会被计入补池——标注体系自证身份
 *     语义下的已知残余，登记不修补。
 */
export function classifyInjectionLine(line: string): SdCategory {
  if (/^\s*-\s*\[结论(?:\||\])/.test(line)) return "L2结论";
  if (/·\s*\[graph:[^\]]*\]\s*$/.test(line)) return "graph补池";
  if (/·\s*\[value:[^\]]*\]\s*$/.test(line)) return "value补池";
  if (/·\s*\[scene:[^\]]*\]\s*$/.test(line)) return "scene补池";
  return "L1九通道";
}

// ============================
// CTR / ALD（spec §2.2 两分量）
// ============================

/**
 * ID 分量一 · 结论 token 占比 CTR = 结论块字符数 / 注入块总字符数。
 * 字符口径：注入行全行（含标注）。空注入（总字符 0）→ 0。
 */
export function computeCTR(lines: readonly string[]): number {
  let conclusionChars = 0;
  let totalChars = 0;
  for (const line of lines) {
    const n = typeof line === "string" ? line.length : 0;
    totalChars += n;
    if (classifyInjectionLine(line) === "L2结论") conclusionChars += n;
  }
  if (totalChars === 0) return 0;
  return conclusionChars / totalChars;
}

/**
 * ID 分量二 · 平均行密度 ALD = 注入块总字符数 / 注入行数。
 * 空注入（0 行）→ 0（除零防御）。
 */
export function computeALD(lines: readonly string[]): number {
  const count = lines.length;
  if (count === 0) return 0;
  const totalChars = lines.reduce((s, l) => s + (typeof l === "string" ? l.length : 0), 0);
  return totalChars / count;
}

// ============================
// SD · 分布 + Shannon 熵（spec §2.3）
// ============================

export interface SdResult {
  /** 五类来源行数分布（键齐全，缺省 0）。 */
  distribution: Record<SdCategory, number>;
  /** Shannon 熵 H = -Σ p_i log2(p_i)（p_i = 类行数 / 总行数；空注入 / 全同源 → 0）。 */
  entropy: number;
}

/**
 * 单次注入的来源分布：注入行按 classifyInjectionLine 分类 → 分布向量 + Shannon 熵。
 * 约定 0·log2(0) = 0（该类不贡献熵）。
 */
export function computeSD(lines: readonly string[]): SdResult {
  const distribution = Object.fromEntries(SD_CATEGORIES.map((c) => [c, 0])) as Record<SdCategory, number>;
  for (const line of lines) {
    distribution[classifyInjectionLine(line)]++;
  }
  const total = lines.length;
  if (total === 0) return { distribution, entropy: 0 };
  let h = 0;
  for (const c of SD_CATEGORIES) {
    const p = distribution[c] / total;
    if (p > 0) h -= p * Math.log2(p);
  }
  return { distribution, entropy: h };
}

// ============================
// CC（spec §2.1 结论覆盖率）
// ============================

/** CC 覆盖判定的结论输入形状（与 L2Conclusion 同构的最小面）。 */
export interface CCConclusionLike {
  sceneName: string;
  content: string;
}

export interface CCQueryInput {
  /** golden query 标识（可选；透传到 perQuery 供口径样本追溯）。 */
  queryId?: string;
  /** 该 query 重放得到的结论层（work_fact content / scene block summary）。 */
  conclusions: readonly CCConclusionLike[];
  /** golden 标注词集（该 query 主题真值的词面表示）。 */
  annotationWords: readonly string[];
  /** golden 标注场景集（可选；expectedScenes 属 E3 一次性标注，缺省空）。 */
  annotationScenes?: readonly string[];
}

export interface CCQueryResult {
  queryId?: string;
  /** 该 query 是否被结论层覆盖（任一结论主题相关）。 */
  covered: boolean;
  /** 结论层是否非空（CC' 分母口径）。 */
  hasConclusions: boolean;
  /** 命中的标注词（口径样本追溯）。 */
  hitWords: string[];
  /** 命中的标注场景（口径样本追溯）。 */
  hitScenes: string[];
}

/**
 * 单条结论的"主题相关"判定（spec §2.1 逐字口径）：
 *   - 文本通道：结论文本含标注词集中**任一词**（子串、大小写不敏感）；
 *   - 场景通道：结论的 sceneName 命中标注场景——命中 = 既有场景命中语义
 *     （detectSceneHit 单一源：大小写不敏感子串 + 层级祖先段）或双向子串包含；
 *   - 二者任一即主题相关；二者皆无 → 不相关（宁缺毋滥）。
 */
export function isTopicRelevantConclusion(
  conclusion: CCConclusionLike,
  annotationWords: readonly string[],
  annotationScenes: readonly string[] = [],
): { hit: boolean; hitWords: string[]; hitScenes: string[] } {
  const content = typeof conclusion?.content === "string" ? conclusion.content : "";
  const lowerContent = content.toLowerCase();
  const hitWords = (annotationWords ?? []).filter(
    (w) => typeof w === "string" && w.length > 0 && lowerContent.includes(w.toLowerCase()),
  );
  const sceneName = typeof conclusion?.sceneName === "string" ? conclusion.sceneName : "";
  const hitScenes = (annotationScenes ?? []).filter((s) => {
    if (typeof s !== "string" || s.length === 0 || !sceneName) return false;
    const lowerS = s.toLowerCase();
    const lowerSn = sceneName.toLowerCase();
    // 命中：detectSceneHit 单一源语义（标注场景含结论场景名或其祖先段）
    // 或结论场景名含标注场景（双向子串，防标注粒度粗于场景名）
    return detectSceneHit(s, [sceneName]) !== null || lowerSn.includes(lowerS) || lowerS.includes(lowerSn);
  });
  return { hit: hitWords.length > 0 || hitScenes.length > 0, hitWords, hitScenes };
}

export interface CCResult {
  /** CC = 覆盖 query 数 / golden query 总数（全量口径）；空 golden → null。 */
  cc: number | null;
  /** CC' = 覆盖数 / 结论层非空 query 数（层内命中率）；分母 0 → null。 */
  ccConditional: number | null;
  coveredCount: number;
  totalQueries: number;
  queriesWithConclusions: number;
  /** 逐 query 判定（含命中词/命中场景——报告口径样本直接取用）。 */
  perQuery: CCQueryResult[];
}

/**
 * CC 聚合（spec §2.1）：CC = 有主题相关结论注入的 query 数 / golden query 总数（全量口径）；
 * 同时报告条件口径 CC' = 覆盖数 / 结论层非空的 query 数（层内命中率）。
 */
export function computeCC(inputs: readonly CCQueryInput[]): CCResult {
  const total = inputs.length;
  if (total === 0) {
    return { cc: null, ccConditional: null, coveredCount: 0, totalQueries: 0, queriesWithConclusions: 0, perQuery: [] };
  }
  let coveredCount = 0;
  let queriesWithConclusions = 0;
  const perQuery: CCQueryResult[] = [];
  for (const input of inputs) {
    const conclusions = Array.isArray(input?.conclusions) ? input.conclusions : [];
    const hasConclusions = conclusions.length > 0;
    if (hasConclusions) queriesWithConclusions++;
    let covered = false;
    const hitWords: string[] = [];
    const hitScenes: string[] = [];
    for (const c of conclusions) {
      const r = isTopicRelevantConclusion(c, input?.annotationWords ?? [], input?.annotationScenes ?? []);
      if (r.hit) {
        covered = true;
        hitWords.push(...r.hitWords);
        hitScenes.push(...r.hitScenes);
      }
    }
    if (covered) coveredCount++;
    perQuery.push({ queryId: input?.queryId, covered, hasConclusions, hitWords: [...new Set(hitWords)], hitScenes: [...new Set(hitScenes)] });
  }
  return {
    cc: coveredCount / total,
    ccConditional: queriesWithConclusions > 0 ? coveredCount / queriesWithConclusions : null,
    coveredCount,
    totalQueries: total,
    queriesWithConclusions,
    perQuery,
  };
}

// ============================
// eval 归档旁挂（A1，pending-backlog：写副本 + CC 塌方侦测线）
// ============================

/**
 * CC 塌方侦测阈值：当前锚 CC 相对上一份已归档锚 CC 的相对降幅 > 50% → 红牌。
 * 红牌不阻塞 exit code（本仓惯例，README「粗门/确定性失败 → 红牌 + stderr loud，不阻塞」）。
 * 阈值口径：3 锚带宽 0（0.40/0.40/0.40）校准，2026-09-12 裁定。
 */
export const CC_COLLAPSE_THRESHOLD = 0.5;

/** 派生副本文件识别：`<原名>.layered.json`（A1 写副本旁挂产物，非独立锚）。 */
export function isLayeredCopyPath(fileName: string): boolean {
  return fileName.endsWith(".layered.json");
}

/**
 * 归档 run JSON 的派生副本路径：`<原名>.json` → `<原名>.layered.json`（同目录旁挂）。
 * 非 .json 后缀路径直接追加（显式传入的自定义锚名兜底）。
 * A1 口径：原档永不改写，layeredMetrics 只落副本（Minor ② 修复——2026-09-12 失败轮
 * 曾原地覆盖 runs/12-11-49.json 指标，靠 git 还原）。
 */
export function deriveLayeredCopyPath(runPath: string): string {
  return runPath.replace(/\.json$/, "") + ".layered.json";
}

/** 归档文件名的前导时间戳键（recall-anchor.mjs 命名口径 `YYYY-MM-DDTHH-mm-ss`）；无前导时间戳 → null。 */
export function parseAnchorTimestampKey(fileName: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/.exec(fileName);
  return m ? m[1] : null;
}

/**
 * "上一份已归档锚"选取（塌方侦测基线，A1 裁定口径）：
 *   - 排除派生副本（.layered.json）与当前锚自身；
 *   - 归档时间 = 文件名前导时间戳；无前导时间戳的文件视为最早（排序垫底）；
 *     同时间戳按文件名字典序（如 `02-42-13-gov4-postrepair-replay.json` 排在
 *     `02-42-13.json` 之后——同键变体只按一个时点参与比较）；
 *   - 只取**严格早于**当前锚的最大者（重放旧锚时不与晚于它的归档对比）；
 *   - 无候选 → null（无基线，调用方跳过侦测，不伪造）。
 * 纯函数：输入为文件名列表（basename），IO（readdir）在 eval-layered-recall.ts 脚本层。
 */
export function pickPreviousAnchorRun(files: readonly string[], currentFileName: string): string | null {
  const currentKey = parseAnchorTimestampKey(currentFileName) ?? "";
  // 码点序比较（< / >）：不依赖 ICU locale，跨机器确定性
  const cmp = (a: { name: string; key: string }, b: { name: string; key: string }) =>
    a.key === b.key ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  const current = { name: currentFileName, key: currentKey };
  const below = files
    .filter((f) => f !== currentFileName && !isLayeredCopyPath(f))
    .map((f) => ({ name: f, key: parseAnchorTimestampKey(f) ?? "" }))
    .filter((x) => cmp(x, current) < 0)
    .sort(cmp);
  if (below.length === 0) return null;
  return below[below.length - 1]!.name;
}

/** 塌方触发载荷（归档 JSON 登记 `ccCollapse` 的字段形状）。 */
export interface CcCollapseResult {
  /** 上一份锚的 CC 基线。 */
  previous: number;
  /** 当前重放 CC。 */
  current: number;
  /** 相对降幅 = (previous − current) / previous。 */
  ratio: number;
}

/**
 * CC 塌方判定：相对降幅 = (previous − current) / previous，**严格大于**阈值才触发
 * （恰等于阈值不触发）。任一侧非有限数值（含 null/undefined）或 previous ≤ 0
 * （正基线不存在，相对降幅无定义）→ null（不侦测、不伪造）。
 */
export function detectCcCollapse(
  previous: number | null | undefined,
  current: number | null | undefined,
  threshold: number = CC_COLLAPSE_THRESHOLD,
): CcCollapseResult | null {
  if (typeof previous !== "number" || !Number.isFinite(previous)) return null;
  if (typeof current !== "number" || !Number.isFinite(current)) return null;
  if (previous <= 0) return null;
  const ratio = (previous - current) / previous;
  return ratio > threshold ? { previous, current, ratio } : null;
}

/** 从归档 run JSON 提取 layeredMetrics.metrics.cc（缺字段 / 非有限数值 → null）。 */
export function extractAnchorCc(runJson: unknown): number | null {
  const v = (runJson as { layeredMetrics?: { metrics?: { cc?: unknown } } } | null | undefined)?.layeredMetrics
    ?.metrics?.cc;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// ============================
// 聚合入口（LayeredMetrics）
// ============================

/** 重放单 query 的注入行输入（结论层 + 经验层，行文本 = 注入形态全行）。 */
export interface LayeredPerQueryInput {
  query: string;
  /** `[结论]`/`[结论|场景]` 标注行（formatConclusionLine 产物）。 */
  conclusionLines: readonly string[];
  /** 经验层注入行（L1 九通道 / 补池标注行）。 */
  experienceLines: readonly string[];
}

export interface LayeredPerQueryResult {
  query: string;
  conclusionLineCount: number;
  experienceLineCount: number;
  totalLineCount: number;
  conclusionChars: number;
  totalChars: number;
  ctr: number;
  ald: number;
  sd: SdResult;
  /** token 估算（辅助字段；IR 分量三待权重校准后启用）。 */
  tokens: { conclusionTokens: number; totalTokens: number };
}

export interface LayeredMetricsResult {
  perQuery: LayeredPerQueryResult[];
  /** 聚合 CTR（micro）：Σ 结论块字符 / Σ 注入块总字符。 */
  ctr: number;
  /** 聚合 ALD：Σ 注入块总字符 / Σ 注入行数。 */
  ald: number;
  /** SD：golden 全集分布均值（有注入 query 的逐 query 占比均值）+ H 均值。 */
  sd: { meanDistribution: Record<SdCategory, number>; meanEntropy: number };
  totals: {
    conclusionChars: number;
    totalChars: number;
    totalLines: number;
    queriesWithLines: number;
  };
}

/**
 * 三指标聚合入口：逐 query 计算 CTR/ALD/SD（注入 = 结论行 + 经验行），
 * 再按 spec §2.2/§2.3 聚合（CTR/ALD 为 micro 聚合比；SD 为分布均值 + H 均值，
 * 均值分母 = 有注入行的 query 数——空注入 query 不进均值，避免零向量稀释）。
 * 纯函数零 IO；CC 由 computeCC 单独聚合（标注词/标注场景属评估侧判定输入）。
 */
export function computeLayeredMetrics(inputs: readonly LayeredPerQueryInput[]): LayeredMetricsResult {
  const perQuery: LayeredPerQueryResult[] = [];
  let conclusionCharsSum = 0;
  let totalCharsSum = 0;
  let totalLinesSum = 0;
  let queriesWithLines = 0;
  const entropySumByQuery: number[] = [];
  const distPropSum = Object.fromEntries(SD_CATEGORIES.map((c) => [c, 0])) as Record<SdCategory, number>;

  for (const input of inputs) {
    const conclusionLines = Array.isArray(input?.conclusionLines) ? input.conclusionLines : [];
    const experienceLines = Array.isArray(input?.experienceLines) ? input.experienceLines : [];
    const allLines = [...conclusionLines, ...experienceLines];
    const conclusionChars = conclusionLines.reduce((s, l) => s + (typeof l === "string" ? l.length : 0), 0);
    const totalChars = allLines.reduce((s, l) => s + (typeof l === "string" ? l.length : 0), 0);
    const sd = computeSD(allLines);
    const row: LayeredPerQueryResult = {
      query: input?.query ?? "",
      conclusionLineCount: conclusionLines.length,
      experienceLineCount: experienceLines.length,
      totalLineCount: allLines.length,
      conclusionChars,
      totalChars,
      ctr: totalChars === 0 ? 0 : conclusionChars / totalChars,
      ald: allLines.length === 0 ? 0 : totalChars / allLines.length,
      sd,
      tokens: {
        conclusionTokens: conclusionLines.reduce((s, l) => s + estimateTokens(l), 0),
        totalTokens: allLines.reduce((s, l) => s + estimateTokens(l), 0),
      },
    };
    perQuery.push(row);
    conclusionCharsSum += conclusionChars;
    totalCharsSum += totalChars;
    totalLinesSum += allLines.length;
    if (allLines.length > 0) {
      queriesWithLines++;
      entropySumByQuery.push(sd.entropy);
      for (const c of SD_CATEGORIES) {
        distPropSum[c] += sd.distribution[c] / allLines.length;
      }
    }
  }

  const meanDistribution = Object.fromEntries(
    SD_CATEGORIES.map((c) => [c, queriesWithLines > 0 ? distPropSum[c] / queriesWithLines : 0]),
  ) as Record<SdCategory, number>;
  const meanEntropy = queriesWithLines > 0
    ? entropySumByQuery.reduce((s, h) => s + h, 0) / queriesWithLines
    : 0;

  return {
    perQuery,
    ctr: totalCharsSum === 0 ? 0 : conclusionCharsSum / totalCharsSum,
    ald: totalLinesSum === 0 ? 0 : totalCharsSum / totalLinesSum,
    sd: { meanDistribution, meanEntropy },
    totals: {
      conclusionChars: conclusionCharsSum,
      totalChars: totalCharsSum,
      totalLines: totalLinesSum,
      queriesWithLines,
    },
  };
}
