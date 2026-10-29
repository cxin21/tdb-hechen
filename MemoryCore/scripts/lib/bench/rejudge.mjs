/**
 * 判分器变更后的「治本」路径（issue #140 的核心诉求）。
 *
 * 判分器一换，历史报告里的 genCorrect 与新报告的 genCorrect 就不是同一把尺子量的。
 * 出路有两条：
 *  1) 重跑基线（贵：召回 + 生成 + 判分全跑一遍）；
 *  2) **用旧报告里已存的答案，按当前判分器重判**（便宜：只花 N 次判分调用）。
 *
 * 报告行本来就存了 answer / answerFinal（b1 档的抽取答案）与 gold，所以 ② 完全可行。
 * 这不是「关掉门禁」，而是把旧数据搬到新尺子下，让跨 judge 的历史对比重新可比。
 *
 * 模块只做「把答案喂给 judge + 重算聚合」，不读文件、不建 LLM（由 CLI 注入），便于单测。
 */
import { aggregate } from "./metrics.mjs";
import { judgeIdentity } from "./judge.mjs";

/** b1 档存的是抽取后的 answerFinal，纯生成档存 answer；空串算「没有答案」。 */
export function answersOf(row) {
  const final = row?.answerFinal;
  if (typeof final === "string" && final.trim()) return final.trim();
  const raw = row?.answer;
  return typeof raw === "string" ? raw.trim() : "";
}

/** 重判时给 judge 的题面：从行本身重建，不依赖原始生成过程。 */
function promptArgsOf(row, datasetName) {
  return {
    question: row?.question ?? "",
    gold: row?.gold ?? "",
    answer: answersOf(row),
    questionType: row?.questionType ?? null,
    datasetName,
  };
}

/**
 * 用旧答案按当前 judge 重判一份报告。
 *  - 不改入参（返回新对象），避免调用方拿到半重判的报告；
 *  - 没有答案的行不重判、也不把「空答案」判成错（原判定保留，打 rejudgeSkipped 标记）；
 *  - config 里留 rejudgedFrom 溯踪（旧 judge 身份 + 时间 + 来源），审计链不断；
 *  - overall/perType 用 aggregate 从 rows 重算，保持与 eval-memory-bench 同口径。
 */
export async function regradeReport({
  report,
  llm,
  buildJudgePrompt,
  limit = Infinity,
  datasetName = null,
  judgePromptVersion = null,
  onProgress = null,
} = {}) {
  if (!report || !llm) throw new Error("regradeReport: report 与 llm 必填");
  if (typeof buildJudgePrompt !== "function") throw new Error("regradeReport: buildJudgePrompt 必填");

  const next = structuredClone(report);
  const from = judgeIdentity(report);
  const ds = datasetName ?? (typeof report?.dataset === "string" ? report.dataset : report?.dataset?.name ?? null);

  let regraded = 0;
  let skipped = 0;
  let remaining = 0;

  for (const row of next.rows ?? []) {
    const answer = answersOf(row);
    if (!answer) {
      skipped += 1;
      row.rejudgeSkipped = "no-answer";
      continue;
    }
    if (regraded >= limit) {
      remaining += 1;
      continue;
    }
    const verdict = await llm.json(
      [{ role: "user", content: buildJudgePrompt(promptArgsOf(row, ds)) }],
      { maxTokens: 512 },
    );
    row.genCorrect = verdict?.correct === true ? 1 : 0;
    row.refused = verdict?.refused === true ? 1 : 0;
    row.judgeReason = verdict?.reason ?? (verdict ? "" : "judge-parse-failed");
    row.judgeRegraded = true;
    regraded += 1;
    onProgress?.({ done: regraded, total: (next.rows ?? []).length });
  }

  const agg = aggregate(next.rows ?? []);
  const out = {
    ...next,
    overall: agg.overall,
    perType: agg.perType,
    config: {
      ...next.config,
      judgeModel: llm.info?.model ?? next.config?.judgeModel ?? null,
      // 提示版本随尺子一起换：不写就会沿用旧报告的值（旧报告缺该字段时，配对会自证 same）。
      judgePromptVersion: judgePromptVersion ?? next.config?.judgePromptVersion ?? null,
      judgeHost: llm.info?.baseUrlHost ?? null,
      judgeApiKeySource: llm.info?.apiKeySource ?? null,
      rejudgedFrom: {
        judgeModel: from.model,
        judgePromptVersion: from.promptVersion,
        judgeHost: from.host,
        generatedAt: report?.generatedAt ?? null,
        report: report?.config?.tag ?? null,
      },
      rejudgedAt: new Date().toISOString(),
    },
  };
  return { report: out, stats: { regraded, skipped, remaining, total: (next.rows ?? []).length } };
}
