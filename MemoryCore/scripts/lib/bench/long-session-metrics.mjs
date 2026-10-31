/**
 * #168 长会话退化基准的度量口径（纯函数：零网络、零写盘）。
 *
 * 与 docs/optimization-results.md 里其他读数的关键差异：这里的 gold 是生成器自带的
 * 字面值（deterministic ground truth），**不经过 LLM judge**，因此不存在「判分器混用」
 * （MiniMax vs scm-flash）的口径问题；代价是它只衡量「值有没有进召回块/命中第一行」，
 * 不衡量答案措辞质量。
 *
 * 指标定义（与 issue #168 对齐）：
 *   - currentHitRate      问当下：gold（最新值）是否出现在注入块/命中行
 *   - staleInjectionRate  问当下：注入块里是否出现**已被取代的旧值**（旧值注入率）
 *   - historyHitRate      问历史：gold（当时的值）是否仍可召回
 *   - dupActiveRowsPerAttr 同一 (实体,属性) 仍有效的证据行数（失效后应降到 1）
 *   - blockChars/Lines     注入块体积（写侧折叠的代价项：块越大 token 越贵）
 *   - writeMs              写侧每轮耗时（embed + upsert；不含 LLM 抽取——本基准预置三元组）
 *   - curve               按 case 轮数分桶 / 按问题位置分桶的命中正确率（退化曲线）
 */

/** 与 scripts/lib/bench/datasets.mjs:normalizeText 同口径（去空白/标点/大小写）。 */
export function normText(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[\[\]()【】、：:，,。；;·'"|?!！？—-]/g, "");
}

export function blockContains(block, value) {
  const v = normText(value);
  if (!v) return false;
  return normText(block).includes(v);
}

export function hitsContain(hits, value) {
  return (hits || []).some((h) => blockContains(h?.clean ?? h?.content, value));
}

export function top1Contains(hits, value) {
  const first = (hits || [])[0];
  return first ? blockContains(first.clean ?? first.content, value) : false;
}

/**
 * 判一道题（question = corpus 生成的 {qid, kind, gold, staleValues, ...}）。
 * recallResult = scripts/lib/bench/store.mjs makeRecall 的返回（hits/block/latencyMs）。
 */
export function evaluateQuestion(question, recallResult) {
  const block = recallResult?.block ?? "";
  const hits = recallResult?.hits ?? [];
  const staleHit = (question.staleValues || []).filter((v) => blockContains(block, v));
  return {
    qid: question.qid,
    kind: question.kind,
    gold: question.gold,
    hitBlock: blockContains(block, question.gold),
    hitTop1: top1Contains(hits, question.gold),
    hitHits: hitsContain(hits, question.gold),
    staleValuesInBlock: staleHit,
    staleInjected: question.kind === "current" && staleHit.length > 0,
    blockChars: block.length,
    blockLines: block ? block.split("\n").filter((l) => l.trim()).length : 0,
    latencyMs: recallResult?.latencyMs ?? null,
    position: question.position ?? null,
    askedTurnIndex: question.askedTurnIndex ?? null,
  };
}

export function percentile(values, p) {
  const xs = values.filter((v) => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const idx = (xs.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return xs[lo];
  return xs[lo] + (xs[hi] - xs[lo]) * (idx - lo);
}

export function stats(values) {
  const xs = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (!xs.length) return { n: 0, mean: null, p50: null, p95: null, max: null };
  const sum = xs.reduce((a, b) => a + b, 0);
  return {
    n: xs.length,
    mean: Math.round((sum / xs.length) * 100) / 100,
    p50: Math.round((percentile(xs, 0.5) ?? 0) * 100) / 100,
    p95: Math.round((percentile(xs, 0.95) ?? 0) * 100) / 100,
    max: Math.round(Math.max(...xs) * 100) / 100,
  };
}

function rate(rows, pred) {
  const n = rows.length;
  if (!n) return { n: 0, rate: null };
  const hit = rows.filter(pred).length;
  return { n, hit, rate: Math.round((hit / n) * 1000) / 1000 };
}

// 分桶边界按生成器实际轮数分布设定（k∈[5,10] 次更新 × 每 session 3-6 filler + 收尾 session，
// 实际落在 31-60 轮）。旧边界 30/45 会让最小档长期为空，「退化曲线」只剩两档。
const SIZE_BUCKETS = [
  { label: "31-38轮", test: (t) => t <= 38 },
  { label: "39-47轮", test: (t) => t > 38 && t <= 47 },
  { label: "48-60轮", test: (t) => t > 47 },
];

function sizeBucketOf(turns) {
  return SIZE_BUCKETS.find((b) => b.test(turns))?.label ?? "?";
}

/**
 * 汇总一个 arm 的读数。
 *
 * @param {object} p
 * @param {Array}  p.evaluations  每题的 evaluateQuestion 结果（带 caseTurns / arm）
 * @param {object} p.rowStats     { attrs:[{attrKey, activeEvidenceRows, activeDistinctValues, canonicalRows}], foldRows }
 * @param {Array}  p.writeLats    每轮写耗时 ms
 * @param {number} p.supersedeMs  写时失效（computeSupersessions + invalidateL1）总耗时
 * @param {Array}  p.supersedeOps 失效操作明细（可选）
 * @param {object} p.ingestStats  ingestCase 返回的统计（written/embedFailed…）
 */
export function summarizeArm({ evaluations, rowStats, writeLats = [], supersedeMs = 0, supersedeOps = [], ingestStats = {}, recallLatencies = [] }) {
  const current = evaluations.filter((e) => e.kind === "current");
  const history = evaluations.filter((e) => e.kind === "history");
  const attrs = rowStats?.attrs ?? [];
  const activeEvidence = attrs.map((a) => a.activeEvidenceRows);
  const activeDistinct = attrs.map((a) => a.activeDistinctValues);
  const duplicated = attrs.filter((a) => a.activeDistinctValues > 1).length;

  const bySize = {};
  for (const b of SIZE_BUCKETS) {
    const cur = current.filter((e) => sizeBucketOf(e.caseTurns ?? 0) === b.label);
    const his = history.filter((e) => sizeBucketOf(e.caseTurns ?? 0) === b.label);
    bySize[b.label] = {
      current: rate(cur, (e) => e.hitBlock),
      currentStale: rate(cur, (e) => e.staleInjected),
      history: rate(his, (e) => e.hitBlock),
    };
  }
  const byPosition = {};
  for (const pos of ["early", "mid", "late"]) {
    const his = history.filter((e) => (e.position ?? "late") === pos);
    byPosition[pos] = rate(his, (e) => e.hitBlock);
  }

  return {
    questions: {
      current: { ...rate(current, (e) => e.hitBlock), top1: rate(current, (e) => e.hitTop1) },
      currentStaleInjection: rate(current, (e) => e.staleInjected),
      history: { ...rate(history, (e) => e.hitBlock), top1: rate(history, (e) => e.hitTop1) },
    },
    duplicates: {
      attrs: attrs.length,
      activeEvidenceRows: stats(activeEvidence),
      activeDistinctValues: stats(activeDistinct),
      dupAttrRate: attrs.length ? Math.round((duplicated / attrs.length) * 1000) / 1000 : null,
      canonicalRows: stats(attrs.map((a) => a.canonicalRows)),
      foldRows: rowStats?.foldRows ?? 0,
    },
    cost: {
      blockChars: stats(evaluations.map((e) => e.blockChars)),
      blockLines: stats(evaluations.map((e) => e.blockLines)),
      writeMs: stats(writeLats),
      recallMs: stats(recallLatencies),
      supersedeMs: Math.round(supersedeMs * 1000) / 1000,
      supersedeOps: supersedeOps.length,
      supersedeOpsSingle: supersedeOps.filter((o) => o.cardinality === "single").length,
      supersedeOpsMulti: supersedeOps.filter((o) => o.cardinality === "multi").length,
    },
    ingest: ingestStats,
    curve: { byCaseSize: bySize, historyByPosition: byPosition },
  };
}
