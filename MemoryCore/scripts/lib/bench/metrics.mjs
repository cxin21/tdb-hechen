/**
 * 基准指标计算：检索（证据是否被召回）+ 生成（LLM 判分）+ LoCoMo token-F1。
 *
 * 口径显式声明（报告里逐条写出，避免"数字好看但定义含糊"）：
 * - session_any@k  ：top-k 内任意一行来自证据 session → 该题算命中（LongMemEval 官方口径）。
 * - session_cov@k  ：命中的证据 session 数 / 证据 session 总数（更严的覆盖口径）。
 * - turn_cov@k     ：命中的证据 turn 数 / 证据 turn 总数（LoCoMo 可精确到轮）。
 * - MRR            ：首个证据命中位次的倒数；无命中记 0。
 * - nDCG@k         ：二值相关性（证据=1）的折扣累积增益。
 * - latency        ：召回端到端毫秒（含 query 扩展/embedding/FTS/精排）。
 */

/** 召回行文本 → 落库 turn id（精确匹配；必要时退化为归一化前缀匹配）。 */
export function makeIdResolver(contentIndex) {
  return (content) => (content ? contentIndex.get(normHead(content)) ?? null : null);
}

/**
 * 归一化：折叠空白后全文比较（不截断）。
 * 教训：曾截断前 120 字 + 召回行带 ·soul[...] 尾注，不同 turn 撞同一 key → 证据错配。
 * 现在先由 stripMemoryLineMeta 剥系统标注，再全文比对，两侧规则一致。
 */
export function normHead(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

/**
 * 单题检索评估。
 * @param {object} p
 * @param {object} p.caseObj  bench case（含 evidenceSessionIds / evidenceTurnIds）
 * @param {Array}  p.hits     [{content, score}] 按召回顺序（已按相关度排序）
 * @param {function} p.resolve content → turn id
 * @param {number} p.k        top-k 截断
 */
export function evalRetrieval({ caseObj, hits, resolve, k }) {
  const top = hits.slice(0, k);
  // 优先用召回行自带的 record id（灌库即 turn id，精确）；退化才走 content→id 反查。
  const ids = top.map((h) => resolve(h.clean ?? h.content)).filter(Boolean);
  const unresolved = top.length - ids.length;
  const evSessions = [...caseObj.evidenceSessionIds];
  const evTurns = [...caseObj.evidenceTurnIds];

  // turn id 形如 lme-<qid>-s<N>-t<M> / lc-<sample>-s<N>-t<M>：解析出 session 坐标
  const sessionOf = (id) => {
    const m = String(id).match(/-s(\d+)-t\d+$/);
    return m ? `session_${Number(m[1])}` : null;
  };

  const hitTurnIds = new Set();
  const hitSessionIds = new Set();
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    hitTurnIds.add(id);
    const s = top[i]?.sessionId ?? sessionOf(id);
    if (s) hitSessionIds.add(String(s));
  }

  const sessionHits = evSessions.filter((s) => hitSessionIds.has(s)).length;
  const turnHits = evTurns.filter((t) => hitTurnIds.has(t)).length;

  // 首个证据命中的位次（turn 级优先，缺 turn 标注时用 session 级）
  const isEvidence = (id) => {
    if (evTurns.length) return hitTurnIds.has(id) && evTurns.includes(id);
    const s = sessionOf(id);
    return s ? caseObj.evidenceSessionIds.has(s) : false;
  };
  let firstRank = 0;
  for (let i = 0; i < ids.length; i++) {
    if (isEvidence(ids[i])) {
      firstRank = i + 1;
      break;
    }
  }

  // nDCG@k（二值）：每行相关当且仅当是证据
  let dcg = 0;
  for (let i = 0; i < ids.length; i++) if (isEvidence(ids[i])) dcg += 1 / Math.log2(i + 2);
  const idealN = Math.min(evTurns.length || evSessions.length, k);
  let idcg = 0;
  for (let i = 0; i < idealN; i++) idcg += 1 / Math.log2(i + 2);

  return {
    k,
    retrieved: ids,
    unresolved,
    sessionAny: evSessions.length ? (sessionHits > 0 ? 1 : 0) : null,
    sessionCov: evSessions.length ? sessionHits / evSessions.length : null,
    turnCov: evTurns.length ? turnHits / evTurns.length : null,
    mrr: firstRank ? 1 / firstRank : 0,
    ndcg: idcg > 0 ? dcg / idcg : null,
    hasEvidence: evSessions.length > 0 || evTurns.length > 0,
  };
}

/** LoCoMo 官方风格 token-F1（小写分词后取并集计数）。 */
export function tokenF1(pred, gold) {
  const norm = (s) =>
    String(s ?? "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter(Boolean);
  const p = norm(pred);
  const g = norm(gold);
  if (!p.length || !g.length) return 0;
  const pc = new Map();
  for (const t of p) pc.set(t, (pc.get(t) || 0) + 1);
  let overlap = 0;
  for (const t of g) {
    const c = pc.get(t) || 0;
    if (c > 0) {
      overlap++;
      pc.set(t, c - 1);
    }
  }
  if (!overlap) return 0;
  const precision = overlap / p.length;
  const recall = overlap / g.length;
  return (2 * precision * recall) / (precision + recall);
}

/** 聚合：总体 + 分题型/分类。 */
export function aggregate(rows) {
  const numeric = [
    "sessionAny", "sessionCov", "turnCov", "mrr", "ndcg", "latencyMs", "genCorrect", "f1", "blockChars",
  ];
  const mean = (list, key) => {
    const v = list.map((r) => r[key]).filter((x) => typeof x === "number" && Number.isFinite(x));
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const summarize = (list) => {
    const out = { n: list.length };
    for (const key of numeric) out[key === "latencyMs" ? "latencyMsMean" : key] = mean(list, key);
    const lat = list.map((r) => r.latencyMs).filter(Number.isFinite).sort((a, b) => a - b);
    if (lat.length) {
      out.latencyMsP50 = lat[Math.floor(lat.length * 0.5)];
      out.latencyMsP95 = lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))];
      out.latencyMsMax = lat[lat.length - 1];
    }
    const judged = list.filter((r) => typeof r.genCorrect === "number");
    out.genJudged = judged.length;
    out.genAccuracy = judged.length ? judged.reduce((a, r) => a + r.genCorrect, 0) / judged.length : null;
    return out;
  };
  const byType = {};
  for (const r of rows) {
    const t = r.questionType || "unknown";
    (byType[t] ||= []).push(r);
  }
  const perType = {};
  for (const [t, list] of Object.entries(byType)) perType[t] = summarize(list);
  return { overall: summarize(rows), perType };
}