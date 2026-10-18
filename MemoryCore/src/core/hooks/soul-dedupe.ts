/**
 * 灵魂注入去重单一源（2026-10-18 生产实测驱动，"有问题的现在直接优化"轮）。
 *
 * 根因实锚（主 tenant introspect，sv-2bd12407）：
 * - 红线 14 条中存在近重复对（环境铁律 ssh 带/不带 -i 两变体，归一 char-bigram
 *   Jaccard=0.608）；次高 0.266（密钥双保险 vs 仓库密扫=语义不同必须保留）。
 * - 价值锚 label 包含近重复对（根因 ⊂ 根因优先）：前者 desc=事故叙事（记忆级，
 *   无句末标点），后者 desc=完整原则句（灵魂级，。结尾）。
 *
 * 设计约束（ADR0003 真实性边界 + #52 批次纪律）：
 * - 只做整行/整锚**选择**（drop），kept 行体逐字保留——不截断、不改写、不合并；
 *   红线"不软化"约束针对行体内容，drop 重复变体=选择而非改写。
 * - 确定性：零随机零时钟零 LLM（D9 同哲学），同输入逐字节同输出。
 * - 输入序=输出 kept 序（保持声明序/value_id 稳定序；winner 原位替换不重排）。
 * - 段级门由调用方携带（SoulRenderOptions.strictRuleDedup / anchorDedup），
 *   缺省 off=逐位现状（soul-assembler.ts:117 段级选项语义同款）。
 *
 * 阈值标定依据：生产 14 条红线全量 pairwise（见票与 introspect 留档），0.45
 * 两侧余量充足（真重复 0.608 / 最大语义异对 0.266）。
 */

/** 红线近重复判定阈值（char-bigram Jaccard；标定=生产 14 行全量 pairwise）。 */
export const DEFAULT_RULE_JACCARD_THRESHOLD = 0.45;

/** containment 通道最小 bigram 集护栏（防短串误判；8 bigram ≈ 9+ 归一字符）。 */
const CONTAIN_MIN_BIGRAMS = 8;

/** containment 通道触发阈值（子串级完全覆盖=1.0；0.9 容忍个别归一差异）。 */
const CONTAINMENT_THRESHOLD = 0.9;

/** 价值锚 label 包含判定的最短归一长度（1 字 label 不触发，防「门」⊂「门禁」类误删）。 */
const ANCHOR_LABEL_MIN_LEN = 2;

/** 行首列表弹头（与 soul-redline-render.ts LIST_BULLET_RE 同族，本文件自带防镜像漂移）。 */
const LEADING_BULLET_RE = /^(?:[-*+·•]|\d+[.、)])\s*/;

/** strict_rule tag token（剥归一噪声用；行体其余内容逐字参与归一）。 */
const TAG_TOKEN_RE = /\[strict_rule\]/g;

/**
 * 归一化：剥行首弹头与 [strict_rule] tag token、去全部空白、小写。
 * 仅用于相似度判定，不触碰渲染字节（kept 行原文返回）。
 */
export function normalizeDedupText(line: string): string {
  return String(line ?? "")
    .replace(LEADING_BULLET_RE, "")
    .replace(TAG_TOKEN_RE, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

/** 字符 char-bigram 集合（Array.from 码点安全；单字符/空串 → 空集）。 */
export function charBigramSet(s: string): Set<string> {
  const chars = Array.from(s);
  const out = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i]! + chars[i + 1]!);
  return out;
}

/** Jaccard 相似度 |∩|/|∪|；双方皆空集 → 1（全同约定）；单方空 → 0。 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 1 : inter / union;
}

/** containment（对称化 min 分母）|∩|/min(|a|,|b|)；任一空集 → 0。 */
function containment(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  const denom = Math.min(a.size, b.size);
  return denom === 0 ? 0 : inter / denom;
}

export interface DedupedLines {
  /** 保留行（原文逐字；声明序）。 */
  kept: string[];
  /** 被去重行 + 原因（可观测性：assembler 落日志，运维可核对未误删语义）。 */
  dropped: { line: string; reason: string }[];
}

/**
 * 行级近重复去重（红线后处理 pass；不依赖输入行是否带 tag）。
 * 判定通道（依序）：① 归一全同 → 保首条；② char-bigram Jaccard ≥ 阈值 →
 * 保留归一后更长者（更具体）；③ containment ≥ 0.9 且双侧 bigram ≥ 8 → 保长。
 * winner 原位替换（kept 序=首现序）。
 */
export function dedupeNearDuplicateLines(
  lines: readonly string[],
  opts?: { jaccardThreshold?: number },
): DedupedLines {
  const threshold = typeof opts?.jaccardThreshold === "number" && opts.jaccardThreshold >= 0 ? opts.jaccardThreshold : DEFAULT_RULE_JACCARD_THRESHOLD;
  const kept: string[] = [];
  const keptNorm: string[] = [];
  const keptSets: Set<string>[] = [];
  const dropped: { line: string; reason: string }[] = [];
  for (const line of lines) {
    const norm = normalizeDedupText(line);
    const set = charBigramSet(norm);
    let hit = -1;
    let reason = "";
    for (let k = 0; k < kept.length; k++) {
      if (norm === keptNorm[k]) {
        hit = k;
        reason = "exact";
        break;
      }
      const j = jaccard(set, keptSets[k]!);
      if (j >= threshold) {
        hit = k;
        reason = `jaccard=${j.toFixed(3)}>=${threshold}`;
        break;
      }
      if (set.size >= CONTAIN_MIN_BIGRAMS && keptSets[k]!.size >= CONTAIN_MIN_BIGRAMS && containment(set, keptSets[k]!) >= CONTAINMENT_THRESHOLD) {
        hit = k;
        reason = `containment=${containment(set, keptSets[k]!).toFixed(3)}`;
        break;
      }
    }
    if (hit === -1) {
      kept.push(line);
      keptNorm.push(norm);
      keptSets.push(set);
      continue;
    }
    // 保长规则：归一后更长者胜出（更具体的不变量留在注入面）。
    if (norm.length > keptNorm[hit]!.length) {
      dropped.push({ line: kept[hit]!, reason: `${reason} → replaced-by-longer` });
      kept[hit] = line;
      keptNorm[hit] = norm;
      keptSets[hit] = set;
    } else {
      dropped.push({ line, reason: `${reason} → kept-first` });
    }
  }
  return { kept, dropped };
}

/** 价值锚 decoratedPair 最小形状（soul-assembler.ts:454 同构 + label）。 */
export interface AnchorPairLike {
  row: string;
  desc: string;
  valueId: string;
  label: string;
}

export interface DedupedPairs<T extends AnchorPairLike> {
  pairs: T[];
  dropped: { label: string; keptLabel: string }[];
}

/** 句末标点判定（完整原则句 vs 事故叙事截断的确定性代理）。 */
const isCompleteSentence = (desc: string): boolean => /[。！？.!?]["」』")】]?$/.test(desc.trim());

/**
 * 价值锚 label 近重复去重（声明序进、首现位出）。
 * 判定：归一 label（去空白小写）全同 → 保首条；包含关系（双向 includes，短侧
 * ≥2 字护栏）→ 择优保留：(1) desc 完整句（句末标点）胜；(2) desc 更长者胜；
 * (3) 平手保首现（声明序=value_id 稳定序，不抖动）。winner 原位替换。
 * 真实性边界：pair 对象原样透传（不复制不改写），仅做集合选择。
 */
export function dedupeAnchorPairs<T extends AnchorPairLike>(pairs: readonly T[]): DedupedPairs<T> {
  const out: T[] = [];
  const outNorm: string[] = [];
  const dropped: { label: string; keptLabel: string }[] = [];
  for (const p of pairs) {
    const norm = String(p?.label ?? "").replace(/\s+/g, "").toLowerCase();
    let hit = -1;
    for (let k = 0; k < out.length; k++) {
      const kn = outNorm[k]!;
      if (norm === kn || (norm.length >= ANCHOR_LABEL_MIN_LEN && kn.length >= ANCHOR_LABEL_MIN_LEN && (kn.includes(norm) || norm.includes(kn)))) {
        hit = k;
        break;
      }
    }
    if (hit === -1) {
      out.push(p);
      outNorm.push(norm);
      continue;
    }
    const cur = out[hit]!;
    const curComplete = isCompleteSentence(cur.desc);
    const newComplete = isCompleteSentence(p.desc);
    const challengerWins =
      newComplete !== curComplete ? newComplete : p.desc.length !== cur.desc.length ? p.desc.length > cur.desc.length : false;
    if (challengerWins) {
      dropped.push({ label: cur.label, keptLabel: p.label });
      out[hit] = p;
      outNorm[hit] = norm;
    } else {
      dropped.push({ label: p.label, keptLabel: cur.label });
    }
  }
  return { pairs: out, dropped };
}
