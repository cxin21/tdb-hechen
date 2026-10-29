#!/usr/bin/env node
/**
 * #146 验收④：生产语料走查「知识更新链」。
 *
 * 用真实写路径（src writeMemory + 真实 sqlite VectorStore，不开任何 mock）跑一段日常对话：
 *   T1 我住在柏林，最近迷上摄影      → 事实行：居住城市=柏林(single) / 爱好=摄影(multi)
 *   T2 另外我还在学吉他              → 事实行：爱好=吉他(multi)（additive，不失效摄影）
 *   T3 我上个月搬到慕尼黑了          → 事实行：居住城市=慕尼黑(single)（只失效柏林那条）
 * 然后逐层打出：JSONL 行 → l1_records（含 metadata 里的 fact_key/cardinality/valid_*）→ 读侧
 * selectByValidity 在「问当下」与「问历史」两种意图下的 kept/dropped。
 *
 * 判据（与票面验收④对齐）：
 *   ① 旧值（柏林）valid_end 落库、行不删除、content 仍是原事实陈述 → 可追溯；
 *   ② 同 turn 的多值兄弟（摄影）与后续 additive（吉他）仍 active → 无连坐；
 *   ③ 事实级效期在 metadata_json 里可读（fact_key / cardinality / fact_of / fact_index）；
 *   ④ 读侧零新机制：soft + presentIntent 才硬丢旧值，问历史时旧值仍可召回。
 *
 * 运行：cd MemoryCore && node --import tsx scripts/audit/r146-walkthrough.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { writeMemory } from "../../src/core/record/l1-writer.ts";
import { VectorStore } from "../../src/core/store/sqlite.ts";
import { selectByValidity } from "../../src/core/recall/validity-policy.ts";

const OUT = path.join(".eval-data", "bench", "r146-walkthrough");
const BASE = path.join(OUT, "base");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(BASE, { recursive: true });

const POLICY = {
  factKey: { enabled: false, separator: " | ", maxFactChars: 240 },
  supersession: { enabled: true },
  factRows: { enabled: true },
};
const embedding = { embed: async () => new Float32Array([1, 0, 0]), getDimensions: () => 3, isReady: () => true };

const store = new VectorStore(path.join(OUT, "vectors.db"), 0);
const init = store.init();
if (store.isDegraded()) {
  console.error("临时库降级：" + init.reason);
  process.exit(1);
}

const TURNS = [
  {
    id: "turn-1",
    at: "2026-03-02T09:12:00.000Z",
    text: "我住在柏林，最近迷上摄影",
    triples: [
      { subject: "用户", predicate: "居住城市", value: "柏林", cardinality: "single", phrase: "用户住在柏林" },
      { subject: "用户", predicate: "爱好", value: "摄影", cardinality: "multi", phrase: "用户最近迷上摄影" },
    ],
  },
  {
    id: "turn-2",
    at: "2026-03-09T10:05:00.000Z",
    text: "另外我还在学吉他",
    triples: [{ subject: "用户", predicate: "爱好", value: "吉他", cardinality: "multi", phrase: "用户还在学吉他" }],
  },
  {
    id: "turn-3",
    at: "2026-04-11T19:40:00.000Z",
    text: "我上个月搬到慕尼黑了",
    triples: [{ subject: "用户", predicate: "居住城市", value: "慕尼黑", cardinality: "single", phrase: "用户搬到慕尼黑" }],
  },
];

for (const t of TURNS) {
  const rec = await writeMemory({
    memory: {
      content: t.text,
      type: "work_fact",
      priority: 60,
      source_message_ids: [],
      metadata: { factTriples: t.triples },
      scene_name: "walkthrough",
      occurred_at: t.at,
      valid_start: t.at,
    },
    decision: { record_id: t.id, action: "store", target_ids: [] },
    baseDir: BASE,
    sessionKey: "s::walkthrough",
    sessionId: "s",
    teamId: "t1",
    userId: "u1",
    agentId: "a1",
    vectorStore: store,
    embeddingService: embedding,
    storage: undefined,
    writePolicy: POLICY,
    logger: undefined,
  });
  if (!rec) console.error("写入失败：" + t.id);
}

// ── 1. JSONL 行（写侧审计面）────────────────────────────────────────────────
const recordsDir = path.join(BASE, "records");
const lines = fs.readdirSync(recordsDir).flatMap((f) =>
  fs.readFileSync(path.join(recordsDir, f), "utf-8").split("\n").filter(Boolean),
);
const parsed = lines.map((l) => JSON.parse(l));
console.log("## 1. JSONL（" + parsed.length + " 行）");
for (const r of parsed) {
  const md = r.metadata ?? {};
  console.log(
    "- " + r.id + " | valid_start=" + (r.valid_start ?? "-") + " | fact_key=" + (md.fact_key ?? "-") +
    " | cardinality=" + (md.cardinality ?? "-") + " | content=" + r.content,
  );
}

// ── 2. l1_records（读侧实际读到的行，含效期）───────────────────────────────
const rows = store
  .queryL1Records({ teamId: "t1", userId: "u1", agentId: "a1" })
  .map((r) => {
    const md = (() => {
      try {
        return JSON.parse(r.metadata_json ?? "{}");
      } catch {
        return {};
      }
    })();
    return {
      id: r.record_id,
      content: r.content,
      valid_start: r.valid_start ?? "",
      valid_end: r.valid_end ?? "",
      fact_key: md.fact_key ?? "",
      cardinality: md.cardinality ?? "",
      fact_of: md.fact_of ?? "",
      fact_index: md.fact_index ?? null,
      subject: md.subject ?? "",
      predicate: md.predicate ?? "",
    };
  })
  .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

console.log("\n## 2. l1_records（" + rows.length + " 行）\n");
console.log("| record_id | fact_key | cardinality | valid_start | valid_end | content |");
console.log("|---|---|---|---|---|---|");
for (const r of rows) {
  console.log(
    "| " + r.id + " | " + (r.fact_key || "-") + " | " + (r.cardinality || "-") + " | " +
    (r.valid_start || "-") + " | " + (r.valid_end || "（空=有效）") + " | " + r.content + " |",
  );
}

// ── 3. 读侧（soft 效期 + 当前/历史两种意图）────────────────────────────────
// 读侧「现在」固定为 T3 之后、今天之前：用来证明区间是 [3-02, 4-11) 而不是 [3-02, 写时刻)。
// 首版脚本这里踩过一次：当时写侧把 valid_end 记成写时刻，于是旧行在 NOW 时点还没到期、
// present 意图硬丢全落空——正是这个失败把「valid_end = 新事实有效起点」这条语义钉了下来。
const NOW = new Date("2026-05-01T00:00:00.000Z");
const related = (a, b) => a.fact_key !== "" && a.fact_key === b.fact_key;
const present = selectByValidity(rows, { now: NOW, mode: "soft", presentIntent: true, hardOnPresentIntent: true, related });
const history = selectByValidity(rows, { now: NOW, mode: "soft", presentIntent: false, related });
const ids = (xs) => xs.map((x) => x.id).join(", ") || "—";
console.log("\n## 3. 读侧 selectByValidity（now=" + NOW.toISOString() + "）\n");
console.log("- soft + 问当下（presentIntent=true）: kept=[" + ids(present.kept) + "] dropped=[" + ids(present.dropped) + "]");
console.log("- soft + 问历史（presentIntent=false）: kept=[" + ids(history.kept) + "] dropped=[" + ids(history.dropped) + "] demoted=[" + ids(history.demoted) + "]");

console.log("\n## 4. 结论");
const oldCity = rows.find((r) => r.content.includes("柏林"));
const newCity = rows.find((r) => r.content.includes("慕尼黑"));
const hobby1 = rows.find((r) => r.content.includes("摄影"));
const hobby2 = rows.find((r) => r.content.includes("吉他"));
const ok = [];
ok.push(["旧值（柏林）valid_end 落库", Boolean(oldCity && oldCity.valid_end)]);
ok.push(["旧值不删除、content 可追溯", Boolean(oldCity && oldCity.content === "用户住在柏林")]);
ok.push(["新值（慕尼黑）有效", Boolean(newCity && !newCity.valid_end)]);
ok.push(["同 turn 多值（摄影）不被连坐", Boolean(hobby1 && !hobby1.valid_end)]);
ok.push(["后续 additive（吉他）仍有效", Boolean(hobby2 && !hobby2.valid_end)]);
ok.push(["事实级效期在 metadata 可读", rows.every((r) => r.fact_key && r.cardinality && r.fact_of)]);
ok.push(["旧行 valid_end = 新值 valid_start（区间首尾相接）", Boolean(oldCity && newCity && oldCity.valid_end === newCity.valid_start)]);
ok.push(["问当下时旧值硬丢", present.dropped.some((r) => r.id === oldCity?.id)]);
ok.push(["问历史时旧值可召回", history.kept.some((r) => r.id === oldCity?.id)]);
for (const [name, pass] of ok) console.log("- [" + (pass ? "PASS" : "FAIL") + "] " + name);
store.close?.();
process.exit(ok.every(([, p]) => p) ? 0 : 1);
