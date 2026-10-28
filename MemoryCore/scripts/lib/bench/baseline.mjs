/**
 * 基线登记表（issue #140 目标 ②）：把「哪份报告是哪个档的基线、用什么判分器判的」
 * 从人的记忆（docs 里的表格、文件名时间戳）搬进一个有结构的 JSON，让门禁能**按 judge 解析基线**。
 *
 * 动机：报告文件名只带时间戳，`b1-off` 这个名字在不同 judge 下出现过两份（scm-flash 70.0% /
 * MiniMax 77.8%）。跨 judge 直接配对算出的「+14.4pp」是尺子差异，不是方法收益。登记表让
 * 「判分器换了」这件事变成一次显式的 audit（judge-changed → 强制重跑基线），而不是静默错配。
 *
 * 文件与 manifest 同级（默认 MemoryCore/.eval-data/bench/lme-baselines.json），
 * 因为 manifest 定义的是「同一批 case」，基线必须与它绑在一起才有可比性。
 */
import fs from "node:fs";
import path from "node:path";

import { judgeIdentity, normalizeText } from "./judge.mjs";

export const BASELINE_REGISTRY_VERSION = 1;
export const REGISTRY_FILENAME = "lme-baselines.json";
/** 默认 manifest（本机 .eval-data 布局）；CLI 与门禁共用一份字面量。 */
export const DEFAULT_MANIFEST = ".eval-data/bench/lme-manifest.json";

/** 登记表路径 = 被登记 manifest 的同目录 + lme-baselines.json。 */
export function registryPathForManifest(manifestPath) {
  return path.join(path.dirname(String(manifestPath)), REGISTRY_FILENAME);
}

export function emptyRegistry() {
  return { version: BASELINE_REGISTRY_VERSION, baselines: [] };
}

const base = (p) => (p ? path.basename(String(p)) : null);
/** 报告里的 dataset 名：字符串或 { name } 两种形态统一成字符串。 */
export const datasetNameOf = (report) =>
  typeof report?.dataset === "string" ? report.dataset : normalizeText(report?.dataset?.name);
const mean = (nums) => (nums.length ? nums.reduce((s, x) => s + x, 0) / nums.length : null);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * 从一份报告生成登记项。
 * 判对/覆盖率**从 rows 重算**而不是抄 overall：overall 是生成时的聚合，重判/裁剪后可能过期，
 * 而 rows 是事实来源（bench-rejudge.mjs 也只改 rows，然后重算 overall）。
 */
export function entryFromReport(report, { file = null, tag = null, at = null } = {}) {
  const cfg = report?.config ?? {};
  const rows = Array.isArray(report?.rows) ? report.rows : [];
  const id = judgeIdentity(report);
  const judged = rows.filter((r) => typeof r?.genCorrect === "number");
  const cov = rows.map((r) => num(r?.["turnCov@5"])).filter((v) => v !== null);
  const dataset = datasetNameOf(report);
  return {
    tag: normalizeText(tag) ?? normalizeText(cfg.tag) ?? base(file) ?? "unnamed",
    judgeModel: id.model,
    judgePromptVersion: id.promptVersion,
    judgeHost: id.host,
    answerModel: normalizeText(cfg.answerModel),
    repoCommit: normalizeText(report?.repoCommit),
    manifest: normalizeText(cfg.manifest),
    dataset,
    n: rows.length,
    genJudged: judged.length,
    genCorrect: mean(judged.map((r) => (r.genCorrect ? 1 : 0))),
    turnCov5: mean(cov),
    report: normalizeText(file),
    recordedAt: at ?? new Date().toISOString(),
  };
}

/** 槽位 = (tag, manifest basename, dataset)：登记/门禁/重判三处必须用同一判等。 */
export const sameSlot = (a, b) =>
  a.tag === b.tag && base(a.manifest) === base(b.manifest) && (a.dataset ?? null) === (b.dataset ?? null);

/** 幂等写入：同 (tag, manifest, dataset) 槽位覆盖，否则追加。返回 {registry, replaced}。 */
export function upsertEntry(registry, entry) {
  const reg = { ...emptyRegistry(), ...registry, baselines: [...(registry?.baselines ?? [])] };
  const idx = reg.baselines.findIndex((e) => sameSlot(e, entry));
  if (idx >= 0) {
    reg.baselines[idx] = entry;
    return { registry: reg, replaced: true };
  }
  reg.baselines.push(entry);
  return { registry: reg, replaced: false };
}

const matchesSlot = (e, { judgeModel = null, manifest = null, dataset = null } = {}) =>
  (!judgeModel || e.judgeModel === judgeModel) &&
  (!manifest || base(e.manifest) === base(manifest)) &&
  (!dataset || (e.dataset ?? null) === dataset);

/** 按 judge + manifest + dataset 找同 judge 基线；judge 必须精确相同。 */
export function findBaseline(registry, opts = {}) {
  if (!opts.judgeModel) return null;
  const hits = (registry?.baselines ?? []).filter((e) => matchesSlot(e, opts));
  return hits.length ? hits[hits.length - 1] : null;
}

/**
 * 门禁基线（--base auto 的解析目标）：同 judge 槽位里优先 gateBaseline:true 的那条，
 * 否则取最后登记的一条。多条同 judge 基线下「最后一条」不该决定门禁口径，所以给了显式标记。
 */
export function findGateBaseline(registry, opts = {}) {
  if (!opts.judgeModel) return null;
  const hits = (registry?.baselines ?? []).filter((e) => matchesSlot(e, opts));
  return hits.find((e) => e.gateBaseline === true) ?? (hits.length ? hits[hits.length - 1] : null);
}

/** 把某条设为门禁基线，并清掉同 judge 槽位其余条目的标记（一个 judge 只有一个门禁基线）。 */
export function markGateBaseline(registry, entry) {
  const reg = { ...emptyRegistry(), ...registry, baselines: [...(registry?.baselines ?? [])] };
  const marked = { ...entry, gateBaseline: true };
  const idx = reg.baselines.findIndex((e) => sameSlot(e, entry));
  if (idx >= 0) reg.baselines[idx] = marked;
  else reg.baselines.push(marked);
  for (let i = 0; i < reg.baselines.length; i++) {
    if (i === idx) continue;
    const e = reg.baselines[i];
    if (e.judgeModel === entry.judgeModel && base(e.manifest) === base(entry.manifest) && (e.dataset ?? null) === (entry.dataset ?? null)) {
      const { gateBaseline, ...rest } = e;
      reg.baselines[i] = rest;
    }
  }
  return reg;
}

/**
 * 判分器切换审计：为一份新报告找它「可配对的」基线。
 *  - ok           ：有同 judge 基线；
 *  - judge-changed：同 manifest 下只有别的 judge 的基线 → 必须重跑基线，不能拿旧基线比；
 *  - missing      ：登记表里根本没有这个 manifest 的基线。
 */
export function judgeBaselineAudit(registry, report) {
  const cfg = report?.config ?? {};
  const manifest = normalizeText(cfg.manifest);
  const dataset = datasetNameOf(report);
  const id = judgeIdentity(report);
  const hit = findGateBaseline(registry, { judgeModel: id.model, manifest, dataset });
  if (hit) return { verdict: "ok", judge: id.model, baseline: hit, staleJudges: [], manifest, dataset };
  const pool = (registry?.baselines ?? []).filter(
    (e) => (!manifest || base(e.manifest) === base(manifest)) && (dataset === null || (e.dataset ?? null) === dataset),
  );
  const staleJudges = [...new Set(pool.map((e) => e.judgeModel ?? null).filter(Boolean))];
  return {
    verdict: staleJudges.length ? "judge-changed" : "missing",
    judge: id.model,
    baseline: null,
    staleJudges,
    manifest,
    dataset,
  };
}

const fmtPct = (v) => (v === null || v === undefined ? "-" : `${(v * 100).toFixed(1)}%`);
const shortSha = (s) => (s ? String(s).slice(0, 8) : "-");

/** 登记表的 markdown 表（bench-baseline.mjs list 与 docs 引用共用）。 */
export function summarizeRegistryLines(registry) {
  const rows = registry?.baselines ?? [];
  const lines = [
    `基线登记表（version ${registry?.version ?? "-"}，${rows.length} 条）`,
    "",
    "| 基线 | 判分模型 | 判分提示 | commit | 题数 | 判对 | turnCov@5 | manifest | 报告 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const e of rows) {
    const judged = e.genJudged ? fmtPct(e.genCorrect) : "-（无判分行）";
    const tagCell = e.gateBaseline ? `${e.tag} ⭐` : e.tag;
    lines.push(
      `| ${tagCell} | ${e.judgeModel ?? "（未记录）"} | ${e.judgePromptVersion ?? "-"} | ${shortSha(e.repoCommit)} | ${e.n} | ${judged} | ${fmtPct(e.turnCov5)} | ${base(e.manifest) ?? "-"} | ${e.report ?? "-"} |`,
    );
  }
  return lines;
}

/** 读登记表：缺失/损坏一律返回空表（并给出 reason 供 CLI 提示），不让门禁因元数据崩掉。 */
export function loadRegistry(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    const baselines = Array.isArray(parsed?.baselines) ? parsed.baselines : [];
    return {
      version: parsed?.version ?? BASELINE_REGISTRY_VERSION,
      baselines: baselines.filter((e) => e && typeof e === "object"),
    };
  } catch (err) {
    return { ...emptyRegistry(), reason: err?.code === "ENOENT" ? "missing" : `unreadable: ${err?.message ?? err}` };
  }
}

export function saveRegistry(file, registry) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const out = { ...registry, version: registry?.version ?? BASELINE_REGISTRY_VERSION, baselines: registry?.baselines ?? [] };
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n", "utf8");
  return file;
}
