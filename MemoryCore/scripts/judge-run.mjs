#!/usr/bin/env node
/**
 * D3 判官软轨（REG-REMAINING-001）：对查询集跑召回，LLM 盲评每条结果的相关性，标注落盘。
 *
 * 盲评纪律：judge LLM 只看 (query, memory content)——不看分数/通道/锚，标注独立于排序信号。
 * 标注用途：D2 校准拟合的训练样本池（随语料增长持续积累）。
 *
 * 用法: node scripts/judge-run.mjs [--limit 5]
 * 输出: docs/superpowers/evals/judge/labels-<date>.jsonl（追加式，每次运行一个文件）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const QUERIES_PATH = path.join(ROOT, "..", "docs/superpowers/evals/judge/queries.json");
const OUT_DIR = path.join(ROOT, "..", "docs/superpowers/evals/judge");

// ── 配置：config-override.json（spec §3.2 最高优先级，与产线网关同源）> yaml ──
const OVERRIDE_PATH = "/data/tdai-memory/config-override.json";
const gwYaml = fs.readFileSync(path.join(ROOT, "tdai-gateway.yaml"), "utf8");
let baseUrl = gwYaml.match(/baseUrl:\s*"([^"]+)"/)?.[1];
let apiKey = gwYaml.match(/apiKey:\s*"([^"]+)"/)?.[1];
let model = gwYaml.match(/model:\s*"([^"]+)"/)?.[1];
try {
  const ov = JSON.parse(fs.readFileSync(OVERRIDE_PATH, "utf8"));
  baseUrl = ov?.llm?.baseUrl || baseUrl;
  apiKey = ov?.llm?.apiKey || apiKey;
  model = ov?.llm?.model || model;
} catch { /* override 不可读 → yaml 兜底 */ }
if (!baseUrl || !apiKey || !model) {
  console.error("[judge] gateway yaml 缺 llm 配置");
  process.exit(1);
}

const limit = Number(process.argv[2] === "--limit" ? process.argv[3] : "") || 5;
const queries = JSON.parse(fs.readFileSync(QUERIES_PATH, "utf8")).queries;
console.log(`[judge] queries=${queries.length} limit=${limit} model=${model}`);

async function recall(query) {
  const res = await fetch("http://127.0.0.1:8420/v3/atomic/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.TDB_KEY}`,
      "x-tdai-service-id": "default",
      "x-tdai-team-id": "team-kcjjqzkxks",
      "x-tdai-user-id": "usr-kfym3ajzme",
      "x-tdai-agent-id": "agt-l5ugn6urg4",
    },
    body: JSON.stringify({ query, limit }),
  });
  const json = await res.json();
  return json?.data?.items ?? [];
}

async function grade(query, items) {
  if (items.length === 0) return [];
  const list = items
    .map((it, i) => `${i + 1}. [${it.type}] ${it.content.slice(0, 220)}`)
    .join("\n");
  const prompt =
    `你是相关性判定器。对给定查询，逐条判定候选记忆的相关性等级：\n` +
    `2 = 直接回答或核心相关；1 = 部分相关（同主题但不对题）；0 = 无关。\n\n` +
    `## 查询\n${query}\n\n## 候选记忆\n${list}\n\n` +
    `只输出 JSON 数组：[{"i":1,"rel":2},...]，i 为候选序号。不要其它文字。`;
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 2048,
    }),
  });
  const json = await res.json();
  const text = json?.choices?.[0]?.message?.content ?? "";
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return items.map((_, k) => ({ i: k + 1, rel: -1 }));
  try { return JSON.parse(m[0]); } catch { return items.map((_, k) => ({ i: k + 1, rel: -1 })); }
}

const outPath = path.join(OUT_DIR, `labels-${new Date().toISOString().slice(0, 10)}.jsonl`);
const out = fs.createWriteStream(outPath, { flags: "a" });
let judged = 0;
for (const q of queries) {
  try {
    const items = await recall(q.query);
    const grades = await grade(q.query, items);
    for (const g of grades) {
      const it = items[(g.i ?? 1) - 1];
      if (!it) continue;
      out.write(JSON.stringify({
        queryId: q.id, query: q.query, intent: q.intent,
        recordId: it.id, contentHead: it.content.slice(0, 120),
        rel: g.rel, judgedAt: new Date().toISOString(),
      }) + "\n");
      judged++;
    }
    console.log(`[judge] ${q.id} "${q.query}" → ${items.length} 候选已评`);
  } catch (err) {
    console.error(`[judge] ${q.id} failed: ${err.message}`);
  }
}
out.end();
console.log(`[judge] 完成: ${judged} 条标注 → ${outPath}`);