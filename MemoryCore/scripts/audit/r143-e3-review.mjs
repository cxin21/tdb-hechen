#!/usr/bin/env node
/**
 * #143 E3：30 题人工抽检——材料生成 + 判定汇总（只读）。
 *
 * 背景（#135 E3 / docs/optimization-results.md §10）：b0base 配置（rerank on、candidates=12、
 * minScore=-2）下 kept<=1 的 27 题"被剪死"，关掉 rerank 后 +35.2pp。系统指标只告诉你 where，
 * 但"证据对人不算充分""系统判 turnCov=1 而注入块里根本没有证据"这类分歧只能人判。本脚本把
 * 30 道题连同证据原文、注入块、系统标签与机器预检一次性摆出来，人只做三件事：
 *   ① 读题，看证据 turn 是否足够支撑回答（足够 / 部分足够 / 不足 / 存疑）；
 *   ② 若与人判不一致，选归因档（拒答过度 / 召回缺口 / 聚合精确数字 / 其他）；
 *   ③ 一句话理由。
 * 汇总时算"人机一致率"，并按 #133 的三桶 + 装配折叠四桶回流。
 *
 * 抽样口径（可复现、不随机）：先在 b0base 报告上分层，再在层内按「难例信息量」排序选取：
 *   A 剪枝拒答      kept<=1 且拒答                      —— §10 的主犯，票面重点
 *   B 判覆盖但未注入  turnCov@5>=1 且注入块里看不到证据 turn —— 桶①（高报）
 *   C 判缺口但证据在   turnCov@5<1 且 top-5 里已有证据 turn  —— 桶②（低报）
 *   D 剪枝未拒答      kept<=1 但答了（可能是运气）
 *   E 检索到但答错    turnCov@5>=1 且证据已注入、仍错      —— 不是检索的锅，用于定桶边界
 *   F 其余（对照组）
 * 层内排序：arm 与 base 的答对翻转 > kept 变化 > turnCov 变化 > caseId；同层同题型最多 2 题，
 * 保证题型摊开。层配额见 QUOTAS，不足则按 A→F 顺序从剩余池补足。
 *
 * 机器预检（写进材料，供人对照，不替代人判）：
 *   · evidence turns 取自数据集 has_answer（与 datasets.mjs 同一派生：lme-<qid>-s<session>-t<turn>）
 *   · inTop / inBlock 用 stripMemoryLineMeta 剥掉系统标注后取证据正文前 64 字做子串匹配
 *     （topContents 与注入块都带 "[日期] User: …" 前缀，故用 includes 而非 startsWith）
 *   · 系统判定 = turnCov@5>=1 ? 足够 : 不足；人判 足够/部分足够 记作足够，存疑不计入分母
 *
 * 用法：
 *   node --import tsx scripts/audit/r143-e3-review.mjs build [--sample 30] [--out DIR] [--doc-dir DIR]
 *   node scripts/audit/r143-e3-review.mjs summarize --verdicts path/to/e3-review-143-verdicts.json
 * 产物（build）：
 *   <out>/e3-review-30.json          机器记录（含证据原文与预检，供汇总/复查）
 *   <out>/e3-human-sample-30.md      人读工作表（覆盖 #135 遗留的旧表，票面路径不变）
 *   <doc-dir>/e3-review-30.html      单文件交互页：逐题判定、进度、导出判定 JSON
 *   <doc-dir>/README.md              抽样口径与复现命令
 * 产物（summarize）：
 *   <doc-dir>/e3-review-summary.md   一致率 + 分歧清单 + 四桶计数（回填票面）
 * 只读：不打开库、不调模型、不写 .eval-data 与 doc-dir 以外的任何位置。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");

const DEFAULTS = {
  base: "MemoryCore/.eval-data/bench/longmemeval-oracle-2026-10-27T05-45-51.json",
  arm: "MemoryCore/.eval-data/bench/r142-deep105-base0.json",
  dataset: ".eval-data/longmemeval_oracle.json",
  out: "MemoryCore/.eval-data/bench",
  docDir: "docs/superpowers/evals/e3-review-30",
  sample: 30,
};

// 层配额：A/B/C 是票面点名的三类分歧，占 24 席；D/E 各留少量做边界，F 一席做对照。
const QUOTAS = { A: 6, B: 8, C: 10, D: 3, E: 2, F: 1 };
const STRATUM_LABEL = {
  A: "A 剪枝拒答",
  B: "B 判覆盖但未注入",
  C: "C 判缺口但已召回",
  D: "D 剪枝未拒答",
  E: "E 检索到但答错",
  F: "F 对照",
};
const STRATUM_ORDER = ["A", "B", "C", "D", "E", "F"];

const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith("--")) || "build";
const arg = (name, dflt) => {
  const i = argv.indexOf("--" + name);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
};
const asPath = (p) => (path.isAbsolute(p) ? p : path.join(REPO, p));
// 输入路径：先按当前工作目录解析（方便直接传下载目录里的判定文件），不存在再回落到仓库根。
const asInputPath = (p) => {
  if (path.isAbsolute(p)) return p;
  const fromCwd = path.resolve(process.cwd(), p);
  return fs.existsSync(fromCwd) ? fromCwd : path.join(REPO, p);
};
const readJson = (p) => JSON.parse(fs.readFileSync(asInputPath(p), "utf8"));
const writeText = (p, s) => {
  const abs = asPath(p);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, s);
  return abs;
};
const pct1 = (x) => (x == null || Number.isNaN(x) ? "—" : (Math.round(x * 1000) / 10).toFixed(1) + "%");
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
const clip = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n) + "…";
};

// 字符 bigram Jaccard（与 src/core/hooks/auto-recall.ts 的 foldNearDuplicates 同口径）
const bigrams = (t) => {
  const set = new Set();
  const s = String(t ?? "");
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
};
const jaccard = (a, b) => {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter || 1);
};
/** 行首 tag「- [type|session]」里的 provenance 标识：同 tag = 同一会话/同一来源。 */
const lineProvenance = (line) => {
  const m = /^\s*-\s*\[([^\]]+)\]/.exec(String(line ?? ""));
  return m ? m[1] : "";
};

// ── 证据 turn（与 scripts/lib/bench/datasets.mjs 的 loadLongMemEval 同源派生） ────────
function evidenceTurnsFor(dataset, caseId) {
  const c = dataset.find((x) => String(x.question_id) === String(caseId));
  if (!c) return { turns: [], question_date: null, error: "dataset 里找不到该题" };
  const sessionIds = c.haystack_session_ids || [];
  const answerSessionIds = new Set(c.answer_session_ids || []);
  const turns = [];
  (c.haystack_sessions || []).forEach((sess, si) => {
    const sid = sessionIds[si] || "s" + (si + 1);
    if (!answerSessionIds.has(sid)) return;
    (sess || []).forEach((m, ti) => {
      if (!m.has_answer) return;
      turns.push({
        id: "lme-" + c.question_id + "-s" + (si + 1) + "-t" + (ti + 1),
        session: si + 1,
        turn: ti + 1,
        role: m.role === "assistant" ? "assistant" : "user",
        date: (c.haystack_dates || [])[si] || null,
        text: String(m.content ?? ""),
      });
    });
  });
  return { turns, question_date: c.question_date || null };
}

// ── 报告行 → 统一口径 ────────────────────────────────────────────────────────────
function rowMetrics(row) {
  const kept = row.gates && row.gates.rerank ? row.gates.rerank.kept : null;
  const tc5 = row["turnCov@5"] != null ? row["turnCov@5"] : row.turnCov;
  const blockText = String(row.block ?? "");
  const lines = blockText.split("\n").filter((l) => l.trim().startsWith("- "));
  return {
    tc5,
    tcInjected: row.turnCovInjected != null ? row.turnCovInjected : null,
    kept,
    dropped: row.gates && row.gates.rerank ? row.gates.rerank.dropped : null,
    injectedLines: row.injectedLines != null ? row.injectedLines : lines.length,
    blockChars: row.blockChars != null ? row.blockChars : blockText.length,
    block: blockText,
    topContents: Array.isArray(row.topContents) ? row.topContents : [],
    retrieved: Array.isArray(row.retrieved) ? row.retrieved : [],
    genCorrect: row.genCorrect === true || row.genCorrect === 1 ? 1 : 0,
    refused: row.refused === true || row.refused === 1 ? 1 : 0,
    answer: row.answerFinal || row.answer || "",
    judgeReason: row.judgeReason || "",
  };
}

function pickConfig(report) {
  const c = report.config || {};
  const eff = c.effectiveConfig || {};
  const keys = [
    "recall.maxResults", "recall.candidateK", "recall.rerank.enabled", "recall.rerank.candidates",
    "recall.rerank.minScore", "recall.rerank.blend", "recall.smallToBig.maxExtraLines",
    "recall.smallToBig.budget", "recall.validity.mode",
  ];
  const out = {};
  for (const k of keys) if (eff[k] !== undefined) out[k] = eff[k];
  return { effective: out, rerank: c.rerank, rerankEnabled: c.rerankEnabled, maxResults: c.maxResults };
}

// ── build ─────────────────────────────────────────────────────────────────────
async function build() {
  const basePath = String(arg("base", DEFAULTS.base));
  const armPath = String(arg("arm", DEFAULTS.arm));
  const dsPath = String(arg("dataset", DEFAULTS.dataset));
  const outDir = String(arg("out", DEFAULTS.out));
  const docDir = String(arg("doc-dir", DEFAULTS.docDir));
  const sampleN = Number(arg("sample", DEFAULTS.sample));

  const base = readJson(basePath);
  const arm = readJson(armPath);
  const dataset = readJson(dsPath);
  const armBy = new Map((arm.rows || []).map((r) => [r.caseId, r]));

  const { stripMemoryLineMeta } = await import("../../src/core/hooks/memory-line-meta.ts");
  const clean = (t) => String(stripMemoryLineMeta(String(t ?? "")));
  const cleanBlock = (t) => String(t ?? "").split("\n").map((l) => clean(l)).join("\n");

  const items = [];
  for (const row of base.rows || []) {
    const m = rowMetrics(row);
    const ev = evidenceTurnsFor(dataset, row.caseId);
    const hayTop = norm(cleanBlock(m.topContents.join("\n")));
    const hayBlock = norm(cleanBlock(m.block));
    const blockLines = String(m.block ?? "")
      .split("\n")
      .filter((l) => /^\s*-\s*\[/.test(l))
      .map((l) => ({ provenance: lineProvenance(l), text: norm(clean(l)) }));
    const evidence = ev.turns.map((t) => {
      const key = norm(clean(t.text)).slice(0, 64);
      const usable = key.length >= 8;
      return {
        ...t,
        retrieved: m.retrieved.includes(t.id),
        inTop: usable && hayTop.includes(key),
        inBlock: usable && hayBlock.includes(key),
        short: !usable,
      };
    });
    const retEv = evidence.filter((e) => e.retrieved);
    let bestJac = 0;
    for (const e of retEv) {
      const gt = norm(clean(e.text));
      for (const b of blockLines) {
        const j = jaccard(gt, b.text);
        if (j > bestJac) bestJac = j;
      }
    }
    const foldSuspect = retEv.length > 0 && evidence.filter((e) => e.inBlock).length < retEv.length && bestJac >= 0.25;
    const armRow = armBy.get(row.caseId);
    items.push({
      caseId: row.caseId,
      questionType: row.questionType,
      question: row.question,
      gold: row.gold,
      questionDate: ev.question_date,
      evidence,
      base: m,
      arm: armRow ? rowMetrics(armRow) : null,
      stratum: "",
      fold: { suspect: foldSuspect, bestJac: Number(bestJac.toFixed(3)), blockLines: blockLines.length },
    });
  }

  // 分层（互斥，按 A→E→C→D→F 优先级）
  for (const it of items) {
    const m = it.base;
    const ev = it.evidence;
    const retCount = ev.filter((e) => e.retrieved).length;
    const inBlockCount = ev.filter((e) => e.inBlock).length;
    const inTopCount = ev.filter((e) => e.inTop).length;
    const visibility =
      ev.length === 0
        ? "本题无 has_answer 证据 turn（abstention/无据可查）"
        : retCount === 0
          ? "证据 turn 全部未召回（retrieved 里没有）"
          : inBlockCount === ev.length
            ? "注入块含全部证据 turn（" + inBlockCount + "/" + ev.length + "）"
            : inBlockCount > 0
              ? "注入块含部分证据 turn（" + inBlockCount + "/" + ev.length + "，已召回 " + retCount + "）"
              : inTopCount > 0
                ? "证据已召回、进了 top-5，却没进注入块（" + inTopCount + "/" + ev.length + "）"
                : "证据已召回但注入块文本里未见（" + retCount + "/" + ev.length + "，疑截断）";
    let bucketHint;
    if (ev.length === 0) bucketHint = "无证据 turn，人判看是否该拒答";
    else if (it.fold.suspect)
      bucketHint =
        "装配折叠（同会话近重折叠：注入块仅 " +
        it.fold.blockLines +
        " 行，与证据文本 bigram Jaccard " +
        it.fold.bestJac +
        " ≥ 0.25，金句被当重复折掉）";
    else if (retCount === 0) bucketHint = "召回缺口（检索没取到证据 turn）";
    else if (inBlockCount === 0)
      bucketHint =
        m.kept != null && m.kept <= 1
          ? "拒答过度（kept=" + m.kept + "，证据被剪光）"
          : "装配剪枝（retrieved 有、注入块没有）";
    else if (inBlockCount < ev.length) bucketHint = "证据不全（部分 turn 未注入）";
    else if (/aggregation|multi-session|temporal/i.test(String(it.questionType)))
      bucketHint = "聚合精确数字/跨会话（证据全也可能算错）";
    else bucketHint = "口径（证据在、系统仍判不足）";
    it.precheck = {
      evidenceCount: ev.length,
      retCount,
      inBlockCount,
      inTopCount,
      systemClaim: m.tc5 >= 1 ? "sufficient" : "insufficient",
      visibility,
      foldSuspect: it.fold.suspect,
      foldJaccard: it.fold.bestJac,
      bucketHint,
    };
    if (m.kept != null && m.kept <= 1 && m.refused) it.stratum = "A";
    else if (m.tc5 >= 1 && inBlockCount === 0) it.stratum = "B";
    else if (m.tc5 >= 1 && inBlockCount > 0 && !m.genCorrect && !m.refused) it.stratum = "E";
    else if (m.tc5 < 1 && retCount > 0) it.stratum = "C";
    else if (m.kept != null && m.kept <= 1) it.stratum = "D";
    else it.stratum = "F";
  }

  // 层内排序（难例信息量）+ 题型摊开
  const infoScore = (it) => {
    const b = it.base;
    const a = it.arm || {};
    let s = 0;
    if (a.genCorrect != null && a.genCorrect !== b.genCorrect) s += 4;
    if (b.kept != null && a.kept != null) s += Math.min(2, Math.abs(a.kept - b.kept));
    if (a.tc5 != null && b.tc5 != null) s += Math.min(1.5, Math.abs(a.tc5 - b.tc5) * 2);
    if (b.kept != null && b.kept <= 1) s += 1;
    return s;
  };
  const byStratum = {};
  for (const it of items) (byStratum[it.stratum] ||= []).push(it);
  for (const k of Object.keys(byStratum)) {
    byStratum[k].sort((x, y) => infoScore(y) - infoScore(x) || String(x.caseId).localeCompare(String(y.caseId)));
  }

  const chosen = [];
  const taken = new Set();
  const pick = (pool, n) => {
    const picked = [];
    const typeCount = new Map();
    for (const it of pool) {
      if (picked.length >= n) break;
      if (taken.has(it.caseId)) continue;
      const t = it.questionType;
      if ((typeCount.get(t) || 0) >= 2) continue;
      picked.push(it);
      taken.add(it.caseId);
      typeCount.set(t, (typeCount.get(t) || 0) + 1);
    }
    for (const it of pool) {
      if (picked.length >= n) break;
      if (taken.has(it.caseId)) continue;
      picked.push(it);
      taken.add(it.caseId);
    }
    return picked;
  };
  for (const k of STRATUM_ORDER) {
    chosen.push(...pick(byStratum[k] || [], Math.min(QUOTAS[k] || 0, (byStratum[k] || []).length)));
  }
  for (const k of STRATUM_ORDER) {
    if (chosen.length >= sampleN) break;
    chosen.push(...pick(byStratum[k] || [], sampleN - chosen.length));
  }
  chosen.sort(
    (x, y) =>
      STRATUM_ORDER.indexOf(x.stratum) - STRATUM_ORDER.indexOf(y.stratum) ||
      String(x.caseId).localeCompare(String(y.caseId)),
  );

  const meta = {
    ticket: "#143 (source #135 E3)",
    generatedAt: new Date().toISOString(),
    base: {
      file: basePath,
      generatedAt: base.generatedAt,
      repoCommit: base.repoCommit,
      config: pickConfig(base),
      overall: base.overall,
    },
    arm: {
      file: armPath,
      generatedAt: arm.generatedAt,
      repoCommit: arm.repoCommit,
      config: pickConfig(arm),
      overall: arm.overall,
    },
    dataset: { file: dsPath, cases: (dataset || []).length },
    sampleSize: chosen.length,
    requestedSample: sampleN,
    quotas: QUOTAS,
    stratumCounts: Object.fromEntries(Object.entries(byStratum).map(([k, v]) => [k, v.length])),
    samplingRule:
      "分层互斥 A→F（见脚本头注释），层内按 arm/base 答对翻转 > kept 差 > turnCov 差 > caseId 排序，同层同题型最多 2 题；配额 " +
      JSON.stringify(QUOTAS) +
      "，不足从剩余池按 A→F 补足。可复现：同一对报告 + 同一 --sample 得同一批题。",
  };
  const sample = {
    meta,
    items: chosen.map((it, i) => ({
      n: i + 1,
      caseId: it.caseId,
      questionType: it.questionType,
      question: it.question,
      gold: it.gold,
      questionDate: it.questionDate,
      stratum: it.stratum,
      stratumLabel: STRATUM_LABEL[it.stratum],
      precheck: it.precheck,
      fold: it.fold,
      evidence: it.evidence,
      base: it.base,
      arm: it.arm,
    })),
  };

  const jsonPath = writeText(path.join(outDir, "e3-review-30.json"), JSON.stringify(sample, null, 1));
  const mdPath = writeText(path.join(outDir, "e3-human-sample-30.md"), renderMarkdown(sample));
  const htmlPath = writeText(path.join(docDir, "e3-review-30.html"), renderHtml(sample));
  const readmePath = writeText(path.join(docDir, "README.md"), renderReadme(sample));

  console.log("sample: " + chosen.length + "/" + sampleN + "  strata=" + JSON.stringify(meta.stratumCounts));
  console.log("wrote " + [jsonPath, mdPath, htmlPath, readmePath].join("\n      "));
  if (chosen.length !== sampleN) console.log("!! 题池不足 " + sampleN + "，实出 " + chosen.length);
}

// ── markdown 工作表（归档 + 离线阅读；交互判定用 HTML） ───────────────────────────
const FENCE = String.fromCharCode(96).repeat(3);

function renderMarkdown(sample) {
  const m = sample.meta;
  const L = [];
  L.push("# #143 E3 · 30 题人工抽检工作表（自动生成，勿手改）");
  L.push("");
  L.push("> 生成：" + m.generatedAt + " · base <code>" + path.basename(m.base.file) + "</code>（" + m.base.repoCommit + "）→ arm <code>" + path.basename(m.arm.file) + "</code>（" + m.arm.repoCommit + "）");
  L.push("> 交互判定页：<code>docs/superpowers/evals/e3-review-30/e3-review-30.html</code>（双击打开，判定存本地，导出 JSON 后跑 summarize）");
  L.push("> 机器记录：<code>MemoryCore/.eval-data/bench/e3-review-30.json</code>（含证据原文，供复查与汇总）");
  L.push("");
  L.push("## 口径");
  L.push("");
  L.push("- **人判**：注入的记忆是否足够支撑回答该题——足够 / 部分足够（有部分、缺关键）/ 不足 / 存疑。");
  L.push("- **系统判定**：<code>turnCov@5&gt;=1</code> 记「足够」，否则「不足」；<code>kept</code> 是 rerank 后保留条数。");
  L.push("- **一致率** = 人判（足够+部分足够 ↔ 足够；不足 ↔ 不足）与系统判定相同的题数 ÷ 非存疑题数。");
  L.push("- **归因桶**（仅判不一致时选）：拒答过度 / 召回缺口 / 聚合精确数字 / 其他。");
  L.push("");
  L.push("## 清单");
  L.push("");
  L.push("| # | case | 题型 | 层 | 证据 turn | 注入 | top5 | 系统 | kept | 注入行 | gen | refuse |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const it of sample.items) {
    const p = it.precheck;
    L.push("| " + it.n + " | <code>" + it.caseId + "</code> | " + it.questionType + " | " + it.stratumLabel + " | " + p.evidenceCount + " | " + p.inBlockCount + " | " + p.inTopCount + " | " + (it.base.tc5 >= 1 ? "够" : "缺") + "(" + it.base.tc5 + ") | " + (it.base.kept == null ? "—" : it.base.kept) + " | " + it.base.injectedLines + " | " + it.base.genCorrect + " | " + it.base.refused + " |");
  }
  L.push("");
  L.push("## 逐题");
  for (const it of sample.items) {
    const b = it.base;
    const a = it.arm;
    L.push("");
    L.push("### " + it.n + ". <code>" + it.caseId + "</code> · " + it.questionType + " · " + it.stratumLabel);
    L.push("");
    L.push("**问**：" + it.question);
    L.push("");
    L.push("**标准答案**：" + clip(it.gold, 300));
    L.push("");
    L.push("**系统**：turnCov@5=" + b.tc5 + (b.kept == null ? "" : " · kept=" + b.kept) + " · 注入行=" + b.injectedLines + " · 答对=" + b.genCorrect + " · 拒答=" + b.refused + (a ? " ｜ arm: tc@5=" + a.tc5 + " kept=" + a.kept + " 答对=" + a.genCorrect + " 拒答=" + a.refused : ""));
    L.push("");
    L.push("**机器预检**：" + it.precheck.visibility + " · 归因提示：" + it.precheck.bucketHint);
    L.push("");
    L.push("**证据 turn**（" + it.evidence.length + "）：");
    it.evidence.forEach((e, i) => {
      const badge = e.short ? "短文本，未做匹配" : !e.retrieved ? "未召回" : e.inBlock ? "已注入" : e.inTop ? "top-5 有、未注入" : "已召回、注入块文本未见";
      L.push("");
      L.push((i + 1) + ". <code>" + e.id + "</code> " + e.role + " · " + (e.date || "—") + " · **" + badge + "**");
      L.push("");
      L.push("   > " + String(e.text).replace(/\n+/g, " ").slice(0, 1200));
    });
    L.push("");
    L.push("**注入块**：");
    L.push("");
    L.push(FENCE);
    L.push(clip(b.block, 1800));
    L.push(FENCE);
    if (b.judgeReason) {
      L.push("");
      L.push("**判词**：" + clip(b.judgeReason, 400));
    }
    L.push("");
    L.push("- 人工判定：足够 / 部分足够 / 不足 / 存疑　　归因：拒答过度 / 召回缺口 / 聚合精确数字 / 其他");
    L.push("- 理由：");
  }
  L.push("");
  return L.join("\n");
}

function renderReadme(sample) {
  const m = sample.meta;
  return [
    "# E3 · 30 题人工抽检（#143）",
    "",
    "本目录只放可入库的评测材料：交互判定页与抽样说明。原始报告与含证据原文的 JSON 在",
    "<code>MemoryCore/.eval-data/bench/</code>（.gitignore 排除，属一次性产物，可随时用命令重建）。",
    "",
    "## 文件",
    "",
    "| 文件 | 用途 |",
    "|---|---|",
    "| <code>e3-review-30.html</code> | 单文件判定页：逐题读证据 → 选足够/部分/不足/存疑 → 不一致时选归因桶 → 一句话理由；判定存 localStorage，可导出 JSON |",
    "| <code>README.md</code> | 本说明（抽样口径与复现命令） |",
    "",
    "## 复现 / 重建",
    "",
    "    cd MemoryCore",
    "    npm run audit:e3:build          # 等价：node scripts/audit/r143-e3-review.mjs build",
    "",
    "默认读 base=" + path.basename(m.base.file) + "（" + m.base.repoCommit + "）、arm=" + path.basename(m.arm.file) + "（" + m.arm.repoCommit + "），",
    "数据集=仓库根 .eval-data/longmemeval_oracle.json。换报告：--base / --arm / --dataset；换题量：--sample。",
    "",
    "## 汇总（拿到判定 JSON 后）",
    "",
    "    cd MemoryCore",
    "    npm run audit:e3:summarize -- --verdicts ~/Downloads/e3-review-143-verdicts.json",
    "",
    "输出 docs/superpowers/evals/e3-review-30/e3-review-summary.md：人机一致率、分歧逐条（含机器预检与归因桶）、按桶计数——直接回填 #143 票面评论。",
    "",
    "## 抽样口径（摘要）",
    "",
    m.samplingRule,
    "",
    "本次各层候选数：" + JSON.stringify(m.stratumCounts) + "；入样分布见工作表清单的「层」列。",
    "",
  ].join("\n");
}

// ── HTML 判定页（单文件、零外部依赖、判定存 localStorage） ─────────────────────────
function renderHtml(sample) {
  const meta = sample.meta;
  const json = JSON.stringify(sample).replace(/</g, "\\u003c");
  const head =
    "<!doctype html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\">\n" +
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n" +
    "<title>#143 E3 · 30 题人工抽检</title>\n<style>\n" +
    ":root{--fg:#1a1a1a;--mut:#666;--bg:#faf9f7;--card:#fff;--line:#e3e0da;--ok:#1a7f4b;--bad:#b3261e;--warn:#8a6100}\n" +
    "*{box-sizing:border-box}\n" +
    "body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif}\n" +
    "header{position:sticky;top:0;z-index:5;background:rgba(250,249,247,.97);border-bottom:1px solid var(--line);padding:14px 20px}\n" +
    "h1{font-size:17px;margin:0 0 4px}\n" +
    ".meta{color:var(--mut);font-size:12px;margin-bottom:8px}\n" +
    ".bar{height:6px;background:#e8e4dd;border-radius:3px;overflow:hidden;max-width:520px}\n" +
    "#fill{height:100%;width:0;background:var(--ok);transition:width .2s}\n" +
    "#progress{font-size:12px;color:var(--mut);margin-top:4px}\n" +
    ".actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px;font-size:13px}\n" +
    "button{font:inherit;font-size:13px;padding:4px 10px;border:1px solid var(--line);background:#fff;border-radius:6px;cursor:pointer}\n" +
    "button.on{background:#1a1a1a;color:#fff;border-color:#1a1a1a}\n" +
    "main{max-width:1020px;margin:0 auto;padding:16px 20px 60px}\n" +
    ".card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:14px 0}\n" +
    ".card.hide{display:none}\n" +
    ".card.done{border-left:4px solid var(--ok)}\n" +
    ".card.mis{border-left:4px solid var(--bad)}\n" +
    ".card.unsure{border-left:4px solid var(--warn)}\n" +
    ".head{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;margin-bottom:6px}\n" +
    ".idx{font-weight:700}\n" +
    ".cid{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:var(--mut)}\n" +
    ".tag{font-size:11px;padding:1px 7px;border-radius:10px;background:#f0ede8;color:#444}\n" +
    ".tag.s{background:#e8f1ff;color:#1a4a8a}\n" +
    ".q{font-weight:600;margin:6px 0}\n" +
    ".gold{color:#333;margin:4px 0 8px}\n" +
    ".gold b,.q b{color:var(--mut);font-weight:600;font-size:12px}\n" +
    ".sys{font-size:12px;color:var(--mut);display:flex;gap:14px;flex-wrap:wrap;border:1px dashed var(--line);border-radius:8px;padding:6px 10px;margin:8px 0}\n" +
    ".sys b{color:#222}\n" +
    "details{margin:6px 0}\n" +
    "summary{cursor:pointer;font-size:13px;color:#333}\n" +
    "pre{white-space:pre-wrap;word-break:break-word;background:#f6f4f0;border-radius:8px;padding:10px;font-size:12.5px;line-height:1.55;margin:6px 0;max-height:320px;overflow:auto}\n" +
    ".turn{border-left:3px solid #ddd;padding:2px 0 2px 10px;margin:8px 0}\n" +
    ".turn .tb{font-size:11.5px;color:var(--mut);margin-bottom:2px}\n" +
    ".b{font-size:10.5px;padding:1px 6px;border-radius:8px;margin-left:6px}\n" +
    ".b.ok{background:#e3f5ea;color:#146b3c}.b.warn{background:#fdf3d8;color:#7a5600}.b.miss{background:#fde8e6;color:#a3231b}\n" +
    ".tt{font-size:13.5px;white-space:pre-wrap;max-height:180px;overflow:auto}\n" +
    ".verdict{display:flex;gap:14px;align-items:center;flex-wrap:wrap;border-top:1px solid var(--line);margin-top:10px;padding-top:10px;font-size:13px}\n" +
    ".verdict label{cursor:pointer}\n" +
    ".verdict select,.verdict input{font:inherit;font-size:12.5px;padding:3px 6px;border:1px solid var(--line);border-radius:6px;background:#fff}\n" +
    ".verdict input{flex:1;min-width:240px}\n" +
    ".chip{font-size:11.5px;padding:2px 8px;border-radius:10px;background:#f0ede8;color:#555}\n" +
    ".chip.agree{background:#e3f5ea;color:#146b3c}.chip.mis{background:#fde8e6;color:#a3231b}.chip.unsure{background:#fdf3d8;color:#7a5600}\n" +
    "footer{color:var(--mut);font-size:12px;text-align:center;padding:20px}\n" +
    "</style>\n</head>\n<body>\n";
  const body =
    "<header>\n" +
    "<h1>#143 E3 · 30 题人工抽检</h1>\n" +
    "<div class=\"meta\">base " + sample.meta.base.repoCommit + "（" + (path.basename(sample.meta.base.file)) + "） → arm " + sample.meta.arm.repoCommit + "（" + (path.basename(sample.meta.arm.file)) + "）· 生成 " + sample.meta.generatedAt + "</div>\n" +
    "<div class=\"bar\"><div id=\"fill\"></div></div>\n<div id=\"progress\"></div>\n" +
    "<div class=\"actions\">" +
    "<button id=\"export\">导出判定 JSON</button>" +
    "<button id=\"copy\">复制 JSON</button>" +
    "<button id=\"reset\">清空本机判定</button>" +
    "<span style=\"flex:1\"></span>" +
    "<button class=\"f\" data-f=\"all\">全部</button>" +
    "<button class=\"f\" data-f=\"todo\">未判</button>" +
    "<button class=\"f\" data-f=\"mismatch\">不一致</button>" +
    "<button class=\"f\" data-f=\"agree\">一致</button>" +
    "</div>\n</header>\n<main id=\"cards\"></main>\n" +
    "<footer>判定只存本机浏览器（localStorage）；导出 JSON 后跑 summarize 汇总一致率与四桶归因。</footer>\n" +
    "<script type=\"application/json\" id=\"data\">" + json + "</script>\n";
  const script =
    "<script>\n" +
    "(function(){\n" +
    "var DATA = JSON.parse(document.getElementById('data').textContent);\n" +
    "var KEY = 'e3-review-143:' + DATA.meta.generatedAt;\n" +
    "var SUFF = ['sufficient','partial','insufficient','unsure'];\n" +
    "var SUFF_LABEL = {sufficient:'足够',partial:'部分足够',insufficient:'不足',unsure:'存疑'};\n" +
    "var BUCKET_LABEL = {refuse:'拒答过度',recall:'召回缺口',fold:'装配折叠',aggregation:'聚合精确数字',other:'其他'};\n" +
    "var state = load();\n" +
    "var filter = 'all';\n" +
    "function load(){try{var o=JSON.parse(localStorage.getItem(KEY)||'{}');return o&&typeof o==='object'?o:{};}catch(e){return {};}}\n" +
    "function save(){try{localStorage.setItem(KEY,JSON.stringify(state));}catch(e){}}\n" +
    "function esc(s){return String(s==null?'':s).replace(/[&<>\"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c];});}\n" +
    "function sysLabel(it){return it.precheck.systemClaim==='sufficient'?'足够':'不足';}\n" +
    "function agreeOf(it){\n" +
    "  var v = state[it.caseId]; if(!v || !v.sufficiency) return null;\n" +
    "  if(v.sufficiency==='unsure') return 'unsure';\n" +
    "  var human = (v.sufficiency==='sufficient'||v.sufficiency==='partial')?'sufficient':'insufficient';\n" +
    "  return human===it.precheck.systemClaim?'agree':'mismatch';\n" +
    "}\n" +
    "function cardHtml(it){\n" +
    "  var b=it.base, a=it.arm, p=it.precheck;\n" +
    "  var h='<div class=\"card\" data-cid=\"'+esc(it.caseId)+'\" data-stratum=\"'+esc(it.stratum)+'\">';\n" +
    "  h+='<div class=\"head\"><span class=\"idx\">'+it.n+'</span><span class=\"cid\">'+esc(it.caseId)+'</span>';\n" +
    "  h+='<span class=\"tag\">'+esc(it.questionType)+'</span><span class=\"tag s\">'+esc(it.stratumLabel)+'</span></div>';\n" +
    "  h+='<div class=\"q\"><b>问</b> '+esc(it.question)+'</div>';\n" +
    "  h+='<div class=\"gold\"><b>标准答案</b> '+esc(it.gold)+'</div>';\n" +
    "  h+='<div class=\"sys\"><span>系统判定 <b>'+sysLabel(it)+'</b>（turnCov@5='+esc(b.tc5)+'）</span>';\n" +
    "  h+='<span>kept <b>'+esc(b.kept==null?'—':b.kept)+'</b></span><span>注入 <b>'+esc(b.injectedLines)+'</b> 行</span>';\n" +
    "  h+='<span>base 答对 <b>'+esc(b.genCorrect)+'</b> · 拒答 <b>'+esc(b.refused)+'</b></span>';\n" +
    "  if(a) h+='<span>arm 答对 <b>'+esc(a.genCorrect)+'</b> · 拒答 <b>'+esc(a.refused)+'</b> · kept '+esc(a.kept==null?'—':a.kept)+'</span>';\n" +
    "  h+='</div>';\n" +
    "  h+='<div class=\"meta\">机器预检：'+esc(p.visibility)+' ｜ 归因提示：'+esc(p.bucketHint)+'</div>';\n" +
    "  if(p.foldSuspect) h+='<div class=\"meta\"><span class=\"b miss\">折叠嫌疑 jac='+esc(p.foldJaccard)+'</span> 同会话近重折叠把金句折掉（见「装配折叠」桶）</div>';\n" +
    "  h+='<details open><summary>证据 turn（'+it.evidence.length+'）</summary>';\n" +
    "  if(!it.evidence.length) h+='<pre>本题无 has_answer 证据 turn（abstention/无据可查）</pre>';\n" +
    "  it.evidence.forEach(function(e,i){\n" +
    "    var badge = e.short?'<span class=\"b\">短文本未匹配</span>':(e.inBlock?'<span class=\"b ok\">已注入</span>':(e.inTop?'<span class=\"b warn\">仅在 top-5</span>':'<span class=\"b miss\">未召回</span>'));\n" +
    "    h+='<div class=\"turn\"><div class=\"tb\">'+(i+1)+'. '+esc(e.id)+' · '+esc(e.role)+' · '+esc(e.date||'—')+badge+'</div>';\n" +
    "    h+='<div class=\"tt\">'+esc(e.text)+'</div></div>';\n" +
    "  });\n" +
    "  h+='</details>';\n" +
    "  h+='<details><summary>base 注入块（'+b.blockChars+' 字）</summary><pre>'+esc(b.block)+'</pre></details>';\n" +
    "  h+='<details><summary>base top-5</summary><pre>'+(b.topContents.length?esc(b.topContents.join('\\n---\\n')):'（空）')+'</pre></details>';\n" +
    "  if(a) h+='<details><summary>arm 注入块 / top-5（对照）</summary><pre>'+esc(a.block)+'</pre><pre>'+(a.topContents.length?esc(a.topContents.join('\\n---\\n')):'（空）')+'</pre></details>';\n" +
    "  if(b.judgeReason) h+='<details><summary>判词</summary><pre>'+esc(b.judgeReason)+'</pre></details>';\n" +
    "  h+='<div class=\"verdict\">';\n" +
    "  SUFF.forEach(function(v){h+='<label><input type=\"radio\" name=\"s-'+esc(it.caseId)+'\" value=\"'+v+'\"> '+SUFF_LABEL[v]+'</label>';});\n" +
    "  h+='<select class=\"bucket\">'; h+='<option value=\"\">归因（不一致时选）</option>';\n" +
    "  Object.keys(BUCKET_LABEL).forEach(function(k){h+='<option value=\"'+k+'\">'+BUCKET_LABEL[k]+'</option>';});\n" +
    "  h+='</select>';\n" +
    "  h+='<input class=\"reason\" placeholder=\"一句话理由（不一致时写清：缺哪条证据 / 证据为何不够）\">';\n" +
    "  h+='<span class=\"chip\">未判</span></div></div>';\n" +
    "  return h;\n" +
    "}\n" +
    "function paintCard(card,it){\n" +
    "  var v=state[it.caseId]||{};\n" +
    "  card.querySelectorAll('input[type=radio]').forEach(function(r){r.checked=(r.value===v.sufficiency);});\n" +
    "  card.querySelector('.bucket').value=v.bucket||'';\n" +
    "  card.querySelector('.reason').value=v.reason||'';\n" +
    "  var chip=card.querySelector('.chip'); var ag=agreeOf(it);\n" +
    "  chip.className='chip '+(ag||'');\n" +
    "  chip.textContent = ag==='agree'?'一致':ag==='mismatch'?'不一致（系统'+(it.precheck.systemClaim==='sufficient'?'高报':'低报')+'）':ag==='unsure'?'存疑':'未判';\n" +
    "  card.className='card '+(ag==='agree'?'done':ag==='mismatch'?'mis':ag==='unsure'?'unsure':'')+(card.classList.contains('hide')?' hide':'');\n" +
    "  if(filter==='todo'&&ag) card.classList.add('hide');\n" +
    "  if(filter==='mismatch'&&ag!=='mismatch') card.classList.add('hide');\n" +
    "  if(filter==='agree'&&ag!=='agree') card.classList.add('hide');\n" +
    "  if(filter==='all') card.classList.remove('hide');\n" +
    "}\n" +
    "function paintAll(){\n" +
    "  var cards=document.querySelectorAll('.card'); var counts={judged:0,agree:0,mismatch:0,unsure:0};\n" +
    "  DATA.items.forEach(function(it,i){\n" +
    "    var card=document.querySelector('.card[data-cid=\"'+it.caseId+'\"]'); if(!card) return;\n" +
    "    card.dataset.n=String(it.n); paintCard(card,it);\n" +
    "    var ag=agreeOf(it); if(!ag) return; counts.judged++; counts[ag]++;\n" +
    "  });\n" +
    "  document.getElementById('fill').style.width=(counts.judged/DATA.items.length*100)+'%';\n" +
    "  document.getElementById('progress').textContent='已判 '+counts.judged+'/'+DATA.items.length+' · 一致 '+counts.agree+' · 不一致 '+counts.mismatch+' · 存疑 '+counts.unsure;\n" +
    "}\n" +
    "document.getElementById('cards').innerHTML=DATA.items.map(cardHtml).join('');\n" +
    "document.addEventListener('change',function(ev){\n" +
    "  var card=ev.target.closest('.card'); if(!card) return; var cid=card.dataset.cid;\n" +
    "  var v=state[cid]||{};\n" +
    "  if(ev.target.type==='radio') v.sufficiency=ev.target.value;\n" +
    "  if(ev.target.classList.contains('bucket')) v.bucket=ev.target.value;\n" +
    "  if(ev.target.classList.contains('reason')) v.reason=ev.target.value;\n" +
    "  state[cid]=v; save(); paintAll();\n" +
    "});\n" +
    "document.addEventListener('input',function(ev){\n" +
    "  if(!ev.target.classList||!ev.target.classList.contains('reason')) return;\n" +
    "  var card=ev.target.closest('.card'); if(!card) return; var cid=card.dataset.cid;\n" +
    "  var v=state[cid]||{}; v.reason=ev.target.value; state[cid]=v; save();\n" +
    "});\n" +
    "function payload(){return {version:1,ticket:'#143',exportedAt:new Date().toISOString(),base:DATA.meta.base.file,arm:DATA.meta.arm.file,verdicts:state};}\n" +
    "document.getElementById('export').addEventListener('click',function(){\n" +
    "  var blob=new Blob([JSON.stringify(payload(),null,1)],{type:'application/json'});\n" +
    "  var a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='e3-review-143-verdicts.json'; a.click();\n" +
    "});\n" +
    "document.getElementById('copy').addEventListener('click',function(){\n" +
    "  var txt=JSON.stringify(payload());\n" +
    "  if(navigator.clipboard) navigator.clipboard.writeText(txt); else {var t=document.createElement('textarea');t.value=txt;document.body.appendChild(t);t.select();document.execCommand('copy');t.remove();}\n" +
    "});\n" +
    "document.getElementById('reset').addEventListener('click',function(){\n" +
    "  if(!confirm('清空本机全部判定？导出的 JSON 不受影响。')) return;\n" +
    "  state={}; save(); paintAll();\n" +
    "});\n" +
    "document.querySelectorAll('button.f').forEach(function(btn){\n" +
    "  btn.addEventListener('click',function(){\n" +
    "    filter=btn.dataset.f; document.querySelectorAll('button.f').forEach(function(x){x.classList.toggle('on',x===btn);});\n" +
    "    document.querySelectorAll('.card').forEach(function(c){c.classList.remove('hide');});\n" +
    "    paintAll();\n" +
    "  });\n" +
    "});\n" +
    "document.querySelector('button.f[data-f=\"all\"]').classList.add('on');\n" +
    "paintAll();\n" +
    "})();\n" +
    "</script>\n</body>\n</html>\n";
  return head + body + script;
}

// ── 汇总：拿判定 JSON 算一致率 + 四桶归因 ──────────────────────────────────────────
function summarize() {
  const samplePath = String(arg("sample", path.join(DEFAULTS.out, "e3-review-30.json")));
  const verdictsPath = arg("verdicts", null);
  if (!verdictsPath || verdictsPath === true) {
    throw new Error("缺少 --verdicts <判定的 JSON 路径>（判定页「导出判定 JSON」得到）");
  }
  const docDir = String(arg("doc-dir", DEFAULTS.docDir));
  const sample = readJson(samplePath);
  const raw = readJson(String(verdictsPath));
  const verdicts = raw && raw.verdicts && typeof raw.verdicts === "object" ? raw.verdicts : raw;

  const BUCKET_LABEL = { refuse: "拒答过度", recall: "召回缺口", fold: "装配折叠", aggregation: "聚合精确数字", other: "其他" };
  const rows = [];
  for (const it of sample.items) {
    const v = (verdicts && verdicts[it.caseId]) || {};
    const sufficiency = SUFFICIENCY.has(v.sufficiency) ? v.sufficiency : null;
    const sys = it.precheck.systemClaim;
    let verdict = "unjudged";
    if (sufficiency === "unsure") verdict = "unsure";
    else if (sufficiency) {
      const human = sufficiency === "sufficient" || sufficiency === "partial" ? "sufficient" : "insufficient";
      verdict = human === sys ? "agree" : "mismatch";
    }
    const bucket = verdict === "mismatch" ? (v.bucket || autoBucket(it)) : "";
    rows.push({
      n: it.n,
      caseId: it.caseId,
      questionType: it.questionType,
      stratum: it.stratum,
      stratumLabel: it.stratumLabel,
      q: it.question,
      sys,
      sufficiency,
      verdict,
      direction: verdict === "mismatch" ? (sys === "sufficient" ? "high" : "low") : "",
      bucket,
      bucketLabel: bucket ? BUCKET_LABEL[bucket] || bucket : "",
      reason: String(v.reason || "").trim(),
      precheck: it.precheck.visibility,
      baseGen: it.base.genCorrect,
      armGen: it.arm ? it.arm.genCorrect : null,
    });
  }

  const judged = rows.filter((r) => r.verdict !== "unjudged");
  const scored = judged.filter((r) => r.verdict !== "unsure");
  const agree = scored.filter((r) => r.verdict === "agree");
  const mismatch = scored.filter((r) => r.verdict === "mismatch");
  const unsure = judged.filter((r) => r.verdict === "unsure");
  const rate = scored.length ? agree.length / scored.length : 0;
  const buckets = {};
  for (const r of mismatch) buckets[r.bucket || "other"] = (buckets[r.bucket || "other"] || 0) + 1;

  const perStratum = STRATUM_ORDER.map((k) => {
    const all = rows.filter((r) => r.stratum === k);
    const sc = all.filter((r) => r.verdict === "agree" || r.verdict === "mismatch");
    const ag = all.filter((r) => r.verdict === "agree");
    return {
      stratum: k,
      label: STRATUM_LABEL[k],
      total: all.length,
      judged: all.filter((r) => r.verdict !== "unjudged").length,
      agree: ag.length,
      mismatch: all.filter((r) => r.verdict === "mismatch").length,
      rate: sc.length ? ag.length / sc.length : null,
    };
  });

  const summary = {
    ticket: "#143 (source #135 E3)",
    generatedAt: new Date().toISOString(),
    sample: samplePath,
    verdicts: String(verdictsPath),
    base: sample.meta.base,
    arm: sample.meta.arm,
    totals: {
      sample: rows.length,
      judged: judged.length,
      scored: scored.length,
      agree: agree.length,
      mismatch: mismatch.length,
      unsure: unsure.length,
      agreementRate: rate,
      highReport: mismatch.filter((r) => r.direction === "high").length,
      lowReport: mismatch.filter((r) => r.direction === "low").length,
      buckets,
      missingReason: mismatch.filter((r) => !r.reason).length,
    },
    perStratum,
    rows,
  };

  const L = [];
  L.push("# #143 E3 · 人机一致率汇总（30 题抽检）");
  L.push("");
  L.push("> 生成：" + summary.generatedAt + " · 判定文件：<code>" + path.basename(String(verdictsPath)) + "</code> · 样本：<code>" + path.basename(samplePath) + "</code>");
  L.push("> base <code>" + path.basename(sample.meta.base.file) + "</code>（" + sample.meta.base.repoCommit + "）→ arm <code>" + path.basename(sample.meta.arm.file) + "</code>（" + sample.meta.arm.repoCommit + "）");
  L.push("");
  L.push("## 结论");
  L.push("");
  L.push("- 已判 **" + judged.length + "/" + rows.length + "**" + (unsure.length ? "（其中存疑 " + unsure.length + " 题，不计入一致率）" : ""));
  L.push("- 人机一致 **" + agree.length + "/" + scored.length + " = " + pct1(rate) + "**（非存疑口径）");
  L.push("- 分歧 **" + mismatch.length + "**：系统高报 " + summary.totals.highReport + " · 系统低报 " + summary.totals.lowReport);
  L.push("- 四桶归因（拒答过度 / 召回缺口 / 装配折叠 / 聚合精确数字）：" + (Object.keys(buckets).length ? Object.entries(buckets).map(([k, v]) => (BUCKET_LABEL[k] || k) + " " + v).join(" · ") : "无分歧") + (summary.totals.missingReason ? "（另有 " + summary.totals.missingReason + " 条分歧未写理由）" : ""));
  L.push("");
  L.push("## 分层一致率");
  L.push("");
  L.push("| 层 | 题意 | 题数 | 已判 | 一致 | 不一致 | 一致率 |");
  L.push("|---|---|---|---|---|---|---|");
  for (const s of perStratum) {
    L.push("| " + s.stratum + " | " + s.label + " | " + s.total + " | " + s.judged + " | " + s.agree + " | " + s.mismatch + " | " + (s.rate == null ? "—" : pct1(s.rate)) + " |");
  }
  L.push("");
  L.push("## 分歧逐条");
  L.push("");
  if (!mismatch.length) L.push("无（全部一致或未判）。");
  else {
    L.push("| # | case | 题型 | 层 | 系统 | 人判 | 方向 | 桶 | 理由 | 机器预检 | base→arm |");
    L.push("|---|---|---|---|---|---|---|---|---|---|---|");
    const HUMAN_LABEL = { sufficient: "足够", partial: "部分足够", insufficient: "不足", unsure: "存疑" };
    for (const r of mismatch) {
      L.push("| " + r.n + " | <code>" + r.caseId + "</code> | " + r.questionType + " | " + r.stratum + " | " + (r.sys === "sufficient" ? "足够" : "不足") + " | " + (HUMAN_LABEL[r.sufficiency] || "—") + " | " + (r.direction === "high" ? "高报" : "低报") + " | " + (r.bucketLabel || "—") + " | " + (r.reason || "—").replace(/\|/g, "\\|") + " | " + r.precheck + " | " + r.baseGen + "→" + r.armGen + " |");
    }
  }
  L.push("");
  L.push("## 各题速览");
  L.push("");
  L.push("| # | case | 层 | 系统 | 人判 | 结论 |");
  L.push("|---|---|---|---|---|---|");
  const HUMAN_LABEL2 = { sufficient: "足够", partial: "部分足够", insufficient: "不足", unsure: "存疑" };
  const VLABEL = { agree: "一致", mismatch: "不一致", unsure: "存疑", unjudged: "未判" };
  for (const r of rows) {
    L.push("| " + r.n + " | <code>" + r.caseId + "</code> | " + r.stratum + " | " + (r.sys === "sufficient" ? "足够" : "不足") + " | " + (HUMAN_LABEL2[r.sufficiency] || "—") + " | " + VLABEL[r.verdict] + " |");
  }
  L.push("");
  L.push("## 回填清单");
  L.push("");
  L.push("- 本文件即 #143 票面「人工 vs 系统一致率」证据，直接引用路径与数字；");
  L.push("- 四桶计数回填 #133 的分桶正文（拒答过度 / 召回缺口 / 装配折叠 / 聚合精确数字）；");
  L.push("- 若一致率低但机器预检显示「注入块含全部证据」，说明问题在生成层而非检索层，记为待查项。");
  L.push("");

  const md = L.join("\n");
  const mdPath = writeText(path.join(docDir, "e3-review-summary.md"), md);
  const jsonPath = writeText(path.join(docDir, "e3-review-summary.json"), JSON.stringify(summary, null, 1));
  console.log(md);
  console.log("\nwrote " + mdPath + "\n      " + jsonPath);
  if (judged.length < rows.length) console.log("!! 还有 " + (rows.length - judged.length) + " 题未判");
}

const SUFFICIENCY = new Set(["sufficient", "partial", "insufficient", "unsure"]);

function autoBucket(it) {
  const p = it.precheck;
  if (p.foldSuspect) return "fold";
  if (it.base.kept != null && it.base.kept <= 1) return "refuse";
  if (p.inTopCount === 0) return "recall";
  if (/aggregation|multi-session|temporal/i.test(String(it.questionType))) return "aggregation";
  return "other";
}

async function main() {
  if (cmd === "summarize") return summarize();
  if (cmd === "build") return build();
  throw new Error("未知子命令：" + cmd + "（可用 build / summarize）");
}

main().catch((err) => {
  console.error("✗ " + String((err && err.message) || err));
  process.exitCode = 1;
});
