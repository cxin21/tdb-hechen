/**
 * #136 生产语料走查（只读）：用真实 L1 records 验证「知识更新链路」的两个性质——
 *  ① 单值属性 vs 多值属性 的契约判定在真实记忆上可解释（不是 bench 造数）；
 *  ② 旧值不删除：历史行原样保留在 JSONL（valid_end 只标记），可追溯。
 *
 * 用法：node --import tsx scripts/audit/r136-corpus-walkthrough.mjs [--data <recordsDir>] [--limit 8]
 * 只读：不写库、不外呼、不改生产数据。
 */
import fs from "node:fs";
import path from "node:path";
import { classifyContentCardinality } from "../../src/core/record/cardinality.ts";
import { supersessionEligibleForContent } from "../../src/core/record/write-policy.ts";

const arg = (name, dflt) => {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
};
const dataDir = String(arg("data", process.env.TDAI_DATA_DIR ?? "D:/TDB/data"));
const limit = Number(arg("limit", 8));
const recordsDir = path.join(dataDir, "records");
const files = fs.readdirSync(recordsDir).filter((f) => f.endsWith(".jsonl")).sort();

const rows = [];
for (const f of files) {
  for (const line of fs.readFileSync(path.join(recordsDir, f), "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r.id === "string" && typeof r.content === "string") rows.push(r);
    } catch { /* 跳过坏行（只读走查不阻塞） */ }
  }
}

const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const subjectOf = (r) => {
  const md = r.metadata && typeof r.metadata === "object" ? r.metadata : {};
  const s = typeof md.subject === "string" ? md.subject.trim() : "";
  return s ? norm(s) : "";
};

const groups = new Map();
for (const r of rows) {
  const key = subjectOf(r);
  if (!key) continue;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}
const chains = [...groups.entries()]
  .map(([subject, list]) => ({ subject, list: list.sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? ""))) }))
  .filter((g) => g.list.length >= 2 && new Set(g.list.map((r) => norm(r.content))).size >= 2)
  .sort((a, b) => String(b.list.at(-1)?.createdAt ?? "").localeCompare(String(a.list.at(-1)?.createdAt ?? "")));

console.log("# #136 生产语料知识更新链路走查（只读）");
console.log(`records 目录: ${recordsDir}（${files.length} 个日分片，${rows.length} 行）`);
console.log(`带 metadata.subject 的实体簇: ${groups.size}；其中内容发生过变化（>=2 种表述）: ${chains.length}`);
console.log("");
let single = 0, multi = 0;
for (const c of chains.slice(0, limit)) {
  const first = c.list[0];
  const last = c.list.at(-1);
  const verdict = classifyContentCardinality(last.content);
  if (verdict.cardinality === "single") single++; else multi++;
  console.log(`## ${c.subject}（${c.list.length} 行）`);
  console.log(`  旧: [${first.id}] ${String(first.createdAt).slice(0, 19)} | ${String(first.content).slice(0, 100)}`);
  console.log(`      保留=yes（JSONL 原样，valid_end=${first.valid_end ?? "<none>"}）`);
  console.log(`  新: [${last.id}] ${String(last.createdAt).slice(0, 19)} | ${String(last.content).slice(0, 100)}`);
  console.log(`  契约: ${verdict.cardinality}（${verdict.reason}）→ ${verdict.cardinality === "single" ? "允许标记旧值失效（只写 valid_end，不删行）" : "additive：新值追加，旧值不失效"}`);
  console.log("");
}
// 契约判定在**全部**真实更新链上的分布（不写库：只按新内容做写侧判定模拟）
const policy = { factKey: { enabled: false, separator: " | ", maxFactChars: 240 }, supersession: { enabled: true } };
let wouldInvalidate = 0, additive = 0;
for (const c of chains) {
  const last = c.list.at(-1);
  if (supersessionEligibleForContent(last.content, policy)) wouldInvalidate++;
  else additive++;
}
console.log(`# 走查汇总：发生更新的实体簇 ${chains.length}；样本判定 single=${single} multi=${multi}`);
console.log(
  `# 写侧契约模拟（全部 ${chains.length} 条真实更新链）：会标记旧值失效 ${wouldInvalidate} 条 / additive（多值，不失效）${additive} 条` +
    `（= ${((additive / chains.length) * 100).toFixed(1)}% 的更新被判为"不该删"）`,
);
const invalidated = rows.filter((r) => r.valid_end);
console.log(`# 旧值保留：全库 ${rows.length} 行中带 valid_end 的 ${invalidated.length} 行仍原样存在于 JSONL（零删除）；示例:`);
for (const r of invalidated.slice(-3)) console.log(`  - [${r.id}] valid_end=${r.valid_end} | ${String(r.content).slice(0, 90)}`);
