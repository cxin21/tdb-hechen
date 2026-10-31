/**
 * 成本与延迟口径段（审计 #170 / M6 配套）。
 *
 * 病根：文档把「embedding 占检索子阶段 94.8%」写成端到端占比，且报告里没有 token 字段，
 * 于是「质量-成本」对照只能靠人肉抄表，还抄错了分母。
 *
 * 口径纪律（写进 cost.caliber，报告自带）：
 * - latency：rows[].latencyMs = **召回端到端**（检索 + 精排 + 组装 + 注入块渲染），
 *   不含生成与判分（生成在 rows 之外发生，不占 latencyMs）。
 * - stages：rows[].searchTiming = 检索**子阶段**（fts/embedding/fact/expand），
 *   不含精排与组装；任何「X 占 Y%」必须说清 Y 是子阶段还是端到端。
 * - rerank：目前 src 只出 perfMs.l1 聚合，无独立计时 ⇒ 这里显式记 null，不编数。
 * - tokens：生成端 usage 仅当中转返回时才有；本段一律用 tokens.mjs 的估算器
 *   （TOKEN_ESTIMATOR_VERSION），与 #160 addUsage 的实账口径分开标注，不得混读。
 */
import { estimateTokens, TOKEN_ESTIMATOR_VERSION } from "./tokens.mjs";

const numOrNull = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function percentile(values, p) {
  const xs = values.filter((v) => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const idx = (xs.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? xs[lo] : xs[lo] + (xs[hi] - xs[lo]) * (idx - lo);
}

function stats(values) {
  const xs = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (!xs.length) return { n: 0, mean: null, p50: null, p95: null, max: null };
  return {
    n: xs.length,
    mean: xs.reduce((s, v) => s + v, 0) / xs.length,
    p50: percentile(xs, 0.5),
    p95: percentile(xs, 0.95),
    max: Math.max(...xs),
  };
}

const sum = (...xs) => {
  const ok = xs.filter((v) => typeof v === "number" && Number.isFinite(v));
  return ok.length ? ok.reduce((s, v) => s + v, 0) : null;
};

/** 每题成本/延迟明细 + 汇总 + 口径说明。rows 直接取报告 rows。 */
export function buildCostSection(rows) {
  const perQuestion = rows.map((r) => {
    const st = r.searchTiming ?? {};
    const promptSource = typeof r.evidence === "string" && r.evidence ? r.evidence : (r.block ?? "");
    const promptTokens = estimateTokens(String(promptSource) + "\n" + String(r.question ?? ""));
    const completionTokens = typeof r.answer === "string" && r.answer ? estimateTokens(r.answer) : null;
    const retrievalStageMs = sum(numOrNull(st.ftsMs), numOrNull(st.embeddingMs), numOrNull(st.factMs), numOrNull(st.expandMs));
    return {
      caseId: r.caseId,
      questionType: r.questionType ?? null,
      promptTokens,
      completionTokens,
      totalTokens: completionTokens == null ? promptTokens : promptTokens + completionTokens,
      recallMs: numOrNull(r.latencyMs),
      retrievalStageMs,
      stages: {
        ftsMs: numOrNull(st.ftsMs),
        embeddingMs: numOrNull(st.embeddingMs),
        factMs: numOrNull(st.factMs),
        expandMs: numOrNull(st.expandMs),
        // 未埋点就是 null：不许拿 l1 聚合冒充精排耗时。
        rerankMs: null,
      },
      perfMs: r.perfMs ?? null,
    };
  });

  const stage = (k) => stats(perQuestion.map((p) => p.stages[k]));
  const emb = perQuestion.map((p) => p.stages.embeddingMs).filter((v) => typeof v === "number");
  const stageTotals = perQuestion.map((p) => p.retrievalStageMs).filter((v) => typeof v === "number");
  const embSum = emb.reduce((s, v) => s + v, 0);
  const stageSum = stageTotals.reduce((s, v) => s + v, 0);

  return {
    schemaVersion: 1,
    caliber: {
      latency:
        "rows[].latencyMs = 召回端到端（检索+精排+组装+注入块渲染），不含生成与判分；生成/判分耗时不在 latencyMs 内",
      stages:
        "rows[].searchTiming = 检索子阶段（fts/embedding/fact/expand），不含精排与组装；『X 占 Y%』必须标注 Y 是子阶段还是端到端",
      rerankMs: "未单独埋点（auto-recall 只出 perfMs.l1 聚合）；要单列需在 src 侧加计时，本段显式记 null",
      tokens: {
        method: TOKEN_ESTIMATOR_VERSION,
        live: false,
        note: "生成端 usage 仅当中转返回时可得；本段按字符估算，与 #160 addUsage 的实账口径分开，不得混读",
      },
    },
    summary: {
      recallMs: stats(perQuestion.map((p) => p.recallMs)),
      retrievalStagesMs: stats(perQuestion.map((p) => p.retrievalStageMs)),
      stages: {
        ftsMs: stage("ftsMs"),
        embeddingMs: stage("embeddingMs"),
        factMs: stage("factMs"),
        expandMs: stage("expandMs"),
        rerankMs: { n: 0, mean: null, p50: null, p95: null, max: null },
      },
      tokens: {
        prompt: stats(perQuestion.map((p) => p.promptTokens)),
        completion: stats(perQuestion.map((p) => p.completionTokens)),
        total: stats(perQuestion.map((p) => p.totalTokens)),
      },
    },
    attribution: {
      // 子阶段内占比：分母 = 子阶段合计，不是端到端。旧文档 94.8% 说的就是这个口径。
      embeddingShareOfStages: stageSum > 0 ? Number((embSum / stageSum).toFixed(4)) : null,
      stagesOfRecall: (() => {
        const rec = perQuestion.map((p) => p.recallMs).filter((v) => typeof v === "number");
        const recSum = rec.reduce((s, v) => s + v, 0);
        return recSum > 0 && stageSum > 0 ? Number((stageSum / recSum).toFixed(4)) : null;
      })(),
      note: "embeddingShareOfStages 的分母是『检索子阶段合计』；stagesOfRecall 才是子阶段占召回端到端的比。二者不可互相替代。",
    },
    perQuestion,
  };
}
