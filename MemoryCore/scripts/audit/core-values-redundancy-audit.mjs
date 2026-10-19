#!/usr/bin/env node
/**
 * core_values 锚冗余审计（只读；报告交付，不落库）——CONTEXT.md 人工裁决合同的配套工具：
 *
 *   背景：default 实例 22 个价值锚存在「取证」族语义扎堆（渲染端已由 MMR 多样性缓解呈现症状，
 *   入库端冗余治理需人工裁决，本脚本只产出证据报告，绝不写库、绝不自动合并/退役锚）。
 *
 *   方法：`label：desc` 全文本经生产同款 embedding（config-override.json embedding 段）向量化，
 *   三通道比对：全对 cosine + label 归一化包含关系 + desc bigram jaccard；
 *   同 node_type 内分级建议（A=alias 合并候选 / B=语义近重复观察 / C=轻度相关），
 *   跨 node_type 只记录不建议（跨类合并语义危险，见 docs/research/2026-10-19-soul-rendering-survey-2025-2026.md）。
 *
 *   用法：node scripts/audit/core-values-redundancy-audit.mjs [--db path] [--override path] [--out path]
 *   缺省：--db $TDAI_DATA_DIR/vectors.db（无 env 则 D:/TDB/data/vectors.db）；
 *        --override $TDAI_DATA_DIR/config-override.json；
 *        --out <repo>/docs/audit/2026-10-19-core-values-redundancy-audit.md
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

function arg(name, dflt) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const dataDir = process.env.TDAI_DATA_DIR || "D:/TDB/data";
const dbPath = arg("db", path.join(dataDir, "vectors.db"));
const overridePath = arg("override", path.join(dataDir, "config-override.json"));
const outPath = arg("out", "D:/TDB/td-agemem/docs/audit/2026-10-19-core-values-redundancy-audit.md");

const ov = JSON.parse(fs.readFileSync(overridePath, "utf8"));
const emb = ov.embedding || {};
if (!emb.baseUrl || !emb.apiKey || !emb.model) {
  console.error("[audit] override 缺 embedding 配置（baseUrl/apiKey/model）");
  process.exit(1);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const cols = db.prepare("PRAGMA table_info(core_values)").all().map((c) => c.name);
const hasNodeType = cols.includes("node_type");
const hasAttrs = cols.includes("attrs_json");
const rows = db.prepare("SELECT value_id AS id,label,weight,origin,agent_id" + (hasNodeType ? ",node_type" : "") + (hasAttrs ? ",attrs_json" : "") + " FROM core_values WHERE state='active' ORDER BY value_id").all();

function attrsOf(r) {
  if (!hasAttrs || !r.attrs_json) return {};
  try { return JSON.parse(r.attrs_json); } catch { return {}; }
}

const anchors = rows.map((r) => ({
  id: r.id,
  label: r.label,
  weight: r.weight,
  origin: r.origin,
  nodeType: hasNodeType ? r.node_type : "theme",
  desc: attrsOf(r).description || "",
  aliases: attrsOf(r).aliases || [],
}));

const auditable = anchors.filter((a) => a.nodeType !== "strict_rule");
const strictRules = anchors.length - auditable.length;

const norm = (s) => s.toLowerCase().replace(/[\s\p{P}]+/gu, "");
function containment(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  return x === y || (x.includes(y) && y.length >= 2) || (y.includes(x) && x.length >= 2);
}
function bigrams(s) {
  const t = norm(s);
  const out = new Set();
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2));
  return out;
}
function jaccardDesc(a, b) {
  const A = bigrams(a.desc || a.label), B = bigrams(b.desc || b.label);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}
function cosine(u, v) {
  if (!u || !v || u.length !== v.length) return 0;
  let dot = 0, nu = 0, nv = 0;
  for (let i = 0; i < u.length; i++) { dot += u[i] * v[i]; nu += u[i] * u[i]; nv += v[i] * v[i]; }
  return nu && nv ? dot / Math.sqrt(nu * nv) : 0;
}

async function embedBatch(texts) {
  const res = await fetch(emb.baseUrl.replace(/\/$/, "") + "/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + emb.apiKey },
    body: JSON.stringify({ model: emb.model, input: texts }),
  });
  if (!res.ok) throw new Error("embed http " + res.status + " " + (await res.text()).slice(0, 200));
  const j = await res.json();
  const arr = Array.isArray(j) ? j : j.data;
  if (!Array.isArray(arr) || arr.length !== texts.length) throw new Error("embed shape mismatch");
  return arr.map((d) => Float32Array.from(d.embedding));
}

const texts = auditable.map((a) => a.label + "：" + (a.desc || a.label));
const vecs = [];
for (let i = 0; i < texts.length; i += 10) {
  const batch = texts.slice(i, i + 10);
  let vs = null;
  for (let attempt = 0; attempt < 2 && !vs; attempt++) {
    try { vs = await embedBatch(batch); } catch (e) { if (attempt === 1) throw e; }
  }
  vecs.push(...vs);
}

const pairs = [];
for (let i = 0; i < auditable.length; i++) {
  for (let j = i + 1; j < auditable.length; j++) {
    const A = auditable[i], B = auditable[j];
    const cos = cosine(vecs[i], vecs[j]);
    const jac = jaccardDesc(A, B);
    const cont = containment(A.label, B.label) || (A.aliases.some((x) => containment(x, B.label))) || (B.aliases.some((x) => containment(x, A.label)));
    pairs.push({ A, B, cos, jac, cont });
  }
}

const sameType = pairs.filter((p) => p.A.nodeType === p.B.nodeType);
const crossType = pairs.filter((p) => p.A.nodeType !== p.B.nodeType);
const allCos = pairs.map((p) => p.cos).sort((a, b) => a - b);
const pct = (q) => allCos.length ? allCos[Math.floor(q * (allCos.length - 1))] : 0;

const A = sameType.filter((p) => p.cont || p.jac >= 0.45);
const B = sameType.filter((p) => !p.cont && p.jac < 0.45 && p.cos >= 0.60);
const C = sameType.filter((p) => !p.cont && p.jac < 0.45 && p.cos >= 0.55 && p.cos < 0.60);
const cross = crossType.filter((p) => p.cos >= 0.60 || p.cont).sort((x, y) => y.cos - x.cos);

const fmtPair = (p) => "| " + p.A.label + "(" + p.A.nodeType + "，`" + p.A.id + "`) | " + p.B.label + "(" + p.B.nodeType + "，`" + p.B.id + "`) | " + p.cos.toFixed(3) + " | " + p.jac.toFixed(3) + " | " + (p.cont ? "是" : "否") + " |";

const lines = [];
lines.push("# core_values 锚冗余审计报告（" + new Date().toISOString().slice(0, 10) + "）");
lines.push("");
lines.push("> 只读审计，不落库；治理动作（alias 合并 / retireValue 退役）一律走人工裁决。生成：`node scripts/audit/core-values-redundancy-audit.mjs`");
lines.push("");
lines.push("## 输入");
lines.push("");
lines.push("- db: `" + dbPath + "`");
lines.push("- embedding: `" + emb.model + "` @ `" + emb.baseUrl + "`（生产同款，config-override.json）");
lines.push("- core_values 共 " + anchors.length + " 条；参与审计（theme/person/character）" + auditable.length + " 条；strict_rule " + strictRules + " 条（硬约束不参与冗余建议）");
lines.push("- 全对 cosine 分布（n=" + allCos.length + "）：p10=" + pct(0.1).toFixed(3) + " / p50=" + pct(0.5).toFixed(3) + " / p90=" + pct(0.9).toFixed(3) + " / max=" + (allCos.length ? allCos[allCos.length - 1].toFixed(3) : "-"));
lines.push("");
lines.push("## 分级结论");
lines.push("");
lines.push("- A 建议 alias 合并候选（label 包含关系或 desc jaccard≥0.45，同 node_type）：" + A.length + " 对");
lines.push("- B 语义近重复观察（cosine≥0.60，同 node_type）：" + B.length + " 对");
lines.push("- C 轻度相关（0.55≤cosine<0.60，同 node_type）：" + C.length + " 对");
lines.push("- 跨 node_type 高相关（仅记录，合并语义危险，不建议）：" + cross.length + " 对");
lines.push("");
lines.push("## A 建议 alias 合并候选（人工裁决）");
lines.push("");
if (A.length) {
  lines.push("| 锚 A | 锚 B | cosine | desc jaccard | label 包含/alias 命中 |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const p of A.sort((x, y) => y.cos - x.cos)) lines.push(fmtPair(p));
} else lines.push("（无）");
lines.push("");
lines.push("裁决模板（逐对执行其一）：① 保留胜者（更完整 desc / 更高 weight / 更早 origin），另一方 attrs.aliases 追加败者 label 后 retireValue；② 若两条 desc 语义各有侧重（非同义），保留双锚并在胜者 desc 里吸收对方侧重点。");
lines.push("");
lines.push("## B 语义近重复观察");
lines.push("");
if (B.length) {
  lines.push("| 锚 A | 锚 B | cosine | desc jaccard | label 包含 |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const p of B.sort((x, y) => y.cos - x.cos)) lines.push(fmtPair(p));
} else lines.push("（无）");
lines.push("");
lines.push("## C 轻度相关");
lines.push("");
if (C.length) {
  for (const p of C.sort((x, y) => y.cos - x.cos)) lines.push("- " + p.A.label + " × " + p.B.label + "（cos=" + p.cos.toFixed(3) + "）");
} else lines.push("（无）");
lines.push("");
lines.push("## 跨 node_type 高相关（仅记录）");
lines.push("");
if (cross.length) {
  for (const p of cross) lines.push("- " + p.A.label + "(" + p.A.nodeType + ") × " + p.B.label + "(" + p.B.nodeType + ") cos=" + p.cos.toFixed(3) + (p.cont ? "（label 包含）" : ""));
} else lines.push("（无）");
lines.push("");
lines.push("## 渲染端联动说明");
lines.push("");
lines.push("- 本报告的扎堆在渲染端已由 MMR 多样性（coreMemory.soulRender.anchorSelect.scorer.mmrLambda=0.7）缓解：同族锚不再同时入选同一 block。");
lines.push("- 渲染端 desc cosine 去重通道（anchorDedup.embeddingThreshold=0.85）对本生产模型为诚实 no-op：本次审计全对 max cos=" + (allCos.length ? allCos[allCos.length - 1].toFixed(3) : "-") + "，绝对阈值跨嵌入模型不可移植（docs/research/2026-10-19-soul-rendering-survey-2025-2026.md）。");
lines.push("- 长期正解=入库端查重：discover 提案已带 containmentGate（v2-router discover 路开启），新增同义提案被包含门拦截；存量冗余按本报告人工裁决。");
lines.push("");

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, lines.join("\n"), "utf8");
console.log("[audit] anchors=" + anchors.length + " pairs=" + pairs.length + " A=" + A.length + " B=" + B.length + " C=" + C.length + " cross=" + cross.length);
console.log("[audit] report -> " + outPath);