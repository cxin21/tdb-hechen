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
 * @param {number} p.k        top-k 截断（主口径，键不带后缀）
 * @param {number[]} [p.kList] 附加多 k 切片（键平铺为 `sessionAny@k` 等；同一份 hits 重切，零额外召回）
 */
export function evalRetrieval({ caseObj, hits, resolve, k, kList = [] }) {
  const evSessions = [...caseObj.evidenceSessionIds];
  const evTurns = [...caseObj.evidenceTurnIds];

  // turn id 形如 lme-<qid>-s<N>-t<M> / lc-<sample>-s<N>-t<M>：解析出 session 坐标
  const sessionOf = (id) => {
    const m = String(id).match(/-s(\d+)-t\d+$/);
    return m ? `session_${Number(m[1])}` : null;
  };

  // 单一 k 的口径计算（主 k 与 kList 共用同一实现，禁止两套算法）
  const evalOneK = (kk) => {
    const top = hits.slice(0, kk);
    // 优先用召回行自带的 turn id（灌库即 turn id，精确）；退化才走 content→id 反查。
    // #166：present-intent 遮蔽后注入行是事实短语，content 反查必然失配 → 必须走 turnId。
    const ids = top.map((h) => h.turnId ?? resolve(h.clean ?? h.content)).filter(Boolean);
    const unresolved = top.length - ids.length;

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
    const idealN = Math.min(evTurns.length || evSessions.length, kk);
    let idcg = 0;
    for (let i = 0; i < idealN; i++) idcg += 1 / Math.log2(i + 2);

    return {
      ids,
      unresolved,
      sessionAny: evSessions.length ? (sessionHits > 0 ? 1 : 0) : null,
      sessionCov: evSessions.length ? sessionHits / evSessions.length : null,
      turnCov: evTurns.length ? turnHits / evTurns.length : null,
      mrr: firstRank ? 1 / firstRank : 0,
      ndcg: idcg > 0 ? dcg / idcg : null,
    };
  };

  const primary = evalOneK(k);
  // #138（2026-10-28）：注入集覆盖率（口径修正）。结论层 additive 档注入行数可超过 maxResults
  // （结论 + 上下文 + 经验 ≈ 7 行），turnCov@5 只数前 5 行，会系统性低估这类档；
  // 「注入集覆盖率」= 对**实际注入的全部行**算 turnCov/sessionCov，是「证据在不在上下文里」的
  // 忠实口径。旧键全部保留（口径连续），新键并列：turnCovInjected / sessionCovInjected。
  const injected = evalOneK(Math.max(hits.length, 1));
  const out = {
    k,
    retrieved: primary.ids,
    unresolved: primary.unresolved,
    sessionAny: primary.sessionAny,
    sessionCov: primary.sessionCov,
    turnCov: primary.turnCov,
    mrr: primary.mrr,
    ndcg: primary.ndcg,
    hasEvidence: evSessions.length > 0 || evTurns.length > 0,
    injectedLines: hits.length,
    sessionCovInjected: injected.sessionCov,
    turnCovInjected: injected.turnCov,
  };
  for (const kk of kList) {
    const r = evalOneK(kk);
    out[`sessionAny@${kk}`] = r.sessionAny;
    out[`sessionCov@${kk}`] = r.sessionCov;
    out[`turnCov@${kk}`] = r.turnCov;
    out[`mrr@${kk}`] = r.mrr;
    out[`ndcg@${kk}`] = r.ndcg;
  }
  return out;
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
    "sessionAny", "sessionCov", "turnCov", "mrr", "ndcg", "latencyMs", "genCorrect", "refused", "f1", "blockChars",
    // #138：注入集覆盖率 + 实际注入行数（口径修正；旧 @k 键继续并列）
    "sessionCovInjected", "turnCovInjected", "injectedLines",
    // B0 多 k 切片：行数据里的 `@k` 后缀键自动并入聚合
    ...[...new Set(rows.flatMap((r) => Object.keys(r).filter((key) => /^(sessionAny|sessionCov|turnCov|mrr|ndcg)@\d+$/.test(key))))]
      .sort((a, b) => Number(a.match(/\d+$/)[0]) - Number(b.match(/\d+$/)[0])),
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
    // 拒答率（judge 规则3 refused）：验收口径 <20%
    out.refusalRate = mean(list, "refused");
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