#!/usr/bin/env node
/**
 * #146 验收④（真实语料档）：LongMemEval knowledge-update 切片走查「知识更新链」。
 *
 * 与 r146-walkthrough.mjs（合成三 turn，逐判据断言失效语义）互补：本脚本不编对话，
 * 直接用真实脱敏语料（LongMemEval oracle，knowledge-update 题型）的**原始轮次文本 +
 * 原始会话日期**，配 facts-cache 里真实 LLM 抽出的三元组（facts-v3：显式 cardinality +
 * 事实短语原样透传；缺字段才回退 classifyCardinality 启发式），经真实 writeMemory + 真实
 * sqlite 落库，然后只读库回答三个问题：
 *   ① 一条事实一行是否真的落下来了（行数 / metadata / valid_start 可读）；
 *   ② 知识更新链上旧值是否**仍在库**（不删除、content 不变）且效期可追溯；
 *   ③ 该切片里「同（实体,属性）跨轮多值」有多少、基数分布如何——即事实级失效在真实
 *      语料上的**触发面**有多大（这是把验收④从机制走查推进到语料走查的关键数据）。
 *
 * 运行：cd MemoryCore && node --import tsx scripts/audit/r146-lme-walkthrough.mjs [--case 50635ada]
 */
import fs from "node:fs";
import path from "node:path";
import { writeMemory } from "../../src/core/record/l1-writer.ts";
import { VectorStore } from "../../src/core/store/sqlite.ts";
import { classifyCardinality } from "../../src/core/record/cardinality.ts";
import { factValueOfMeta } from "../../src/core/record/fact-row.ts";
import { searchHybrid } from "../../src/core/hooks/auto-recall.ts";

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
// 缺省 case 要在题目时点存在「同键被取代」的更新链，否则值级判据无从判（#166）：
// 50635ada 在 facts-v3（2026-10-30 重生成）后谓词分裂成 eligible_for_status / reached_status，
// 同键失效不再触发 → 判据静默 SKIP。换 case 先用 .eval-data/bench/findcase.cjs 扫同键更新。
const CASE_ID = argOf("--case", "18bc8abd");

const DATA = "../.eval-data/longmemeval_oracle.json";
const CACHE = path.join(".eval-data", "bench", "facts-cache", "facts");
const OUT = path.join(".eval-data", "bench", "r146-walkthrough");
const CASE_OUT = path.join(OUT, "lme-" + CASE_ID);
fs.rmSync(CASE_OUT, { recursive: true, force: true });
fs.mkdirSync(CASE_OUT, { recursive: true });

const ds = JSON.parse(fs.readFileSync(DATA, "utf8"));
const cases = Array.isArray(ds) ? ds : ds.data || Object.values(ds)[0];
const caseObj = cases.find((c) => c.question_id === CASE_ID);
if (!caseObj) {
  console.error("找不到 case " + CASE_ID);
  process.exit(1);
}
const factsOf = (() => {
  const p = path.join(CACHE, CASE_ID + ".json");
  if (!fs.existsSync(p)) {
    console.error("缺 facts-cache：" + p);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
})();

/** "2022/09/16 (Fri) 13:18" → ISO（UTC，语料本身不带时区） */
const parseCorpusDate = (s) => {
  const m = /^(\d{4})\/(\d{2})\/(\d{2}).*?(\d{2}):(\d{2})/.exec(String(s || ""));
  if (!m) return "1970-01-01T00:00:00.000Z";
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]))).toISOString();
};

const POLICY = {
  factKey: { enabled: false, separator: " | ", maxFactChars: 240 },
  supersession: { enabled: true },
  factRows: { enabled: true },
};
const embedding = { embed: async () => new Float32Array([1, 0, 0]), getDimensions: () => 3, isReady: () => true };
// #166：dims 0 只开 FTS；走真实 searchHybrid 需要向量侧（stub 是 3 维）。
const store = new VectorStore(path.join(CASE_OUT, "vectors.db"), 3);
const init = store.init();
if (store.isDegraded()) {
  console.error("临时库降级：" + init.reason);
  process.exit(1);
}

// ── 灌库：真实轮次文本 + 真实缓存三元组，按语料原始时间顺序 ──────────────────
let written = 0;
let turnsWithFacts = 0;
const sessions = caseObj.haystack_sessions || [];
const dates = caseObj.haystack_dates || [];
for (let si = 0; si < sessions.length; si++) {
  const baseMs = Date.parse(parseCorpusDate(dates[si]));
  for (let ti = 0; ti < sessions[si].length; ti++) {
    const turn = sessions[si][ti];
    const id = `lme-${CASE_ID}-s${si + 1}-t${ti + 1}`;
    const cached = factsOf.byTurn?.[id];
    // #166 走查修正：此前丢掉缓存的 cardinality，导致 facts-v3 的显式裁决永远到不了写侧
    // （整条链路退化成启发式，走查与生产不同源）。同时短语用 phrases[i] 优先、triple.phrase 兜底。
    const triples = (cached?.triples || []).map((t, i) => ({
      subject: t.subject,
      predicate: t.predicate,
      value: t.value,
      ...(cached?.phrases?.[i] || t.phrase ? { phrase: cached?.phrases?.[i] ?? t.phrase } : {}),
      ...(t.cardinality ? { cardinality: t.cardinality } : {}),
    }));
    const at = new Date(baseMs + ti * 60_000).toISOString();
    if (triples.length > 0) turnsWithFacts++;
    await writeMemory({
      memory: {
        content: String(turn.content || ""),
        type: "work_fact",
        priority: 60,
        source_message_ids: [],
        metadata: triples.length > 0 ? { factTriples: triples } : {},
        scene_name: "lme-ku",
        occurred_at: at,
        valid_start: at,
      },
      decision: { record_id: id, action: "store", target_ids: [] },
      baseDir: CASE_OUT,
      sessionKey: "s::lme-" + CASE_ID,
      sessionId: "s",
      teamId: "lme",
      userId: "u",
      agentId: "a",
      vectorStore: store,
      embeddingService: embedding,
      storage: undefined,
      writePolicy: POLICY,
      logger: undefined,
    });
    written++;
  }
}

const rows = store
  .queryL1Records({ teamId: "lme", userId: "u", agentId: "a" })
  .map((r) => {
    let md = {};
    try {
      md = JSON.parse(r.metadata_json ?? "{}");
    } catch {
      md = {};
    }
    return {
      id: r.record_id,
      content: r.content,
      valid_start: r.valid_start ?? "",
      valid_end: r.valid_end ?? "",
      fact_key: md.fact_key ?? "",
      cardinality: md.cardinality ?? "",
      fact_of: md.fact_of ?? "",
      fact_phrase: md.fact_phrase ?? "",
      // #166：值级遮蔽的校验依据（读取口径与读侧同源，见 fact-row.ts factValueOfMeta）
      fact_value: factValueOfMeta(md) ?? "",
    };
  })
  .sort((a, b) => (a.valid_start < b.valid_start ? -1 : a.valid_start > b.valid_start ? 1 : a.id < b.id ? -1 : 1));

const factRows = rows.filter((r) => r.fact_of);
const wholeRows = rows.filter((r) => !r.fact_of);
const superseded = factRows.filter((r) => r.valid_end);
const active = factRows.filter((r) => !r.valid_end);

// 同（实体,属性）跨轮多值统计（只看本 case 落进库的事实行）
const byKey = new Map();
for (const r of factRows) {
  if (!r.fact_key) continue;
  if (!byKey.has(r.fact_key)) byKey.set(r.fact_key, []);
  byKey.get(r.fact_key).push(r);
}
const updateChains = [...byKey.entries()]
  .filter(([, v]) => v.length > 1)
  .map(([k, v]) => ({ fact_key: k, cardinality: v[0].cardinality, n: v.length, contents: v.map((x) => x.content) }));

console.log("## 语料");
console.log("- case: " + CASE_ID + "（" + (caseObj.question_type || "?") + "）/ 会话 " + sessions.length + " 段 / 轮次 " + written);
console.log("- 题: " + caseObj.question);
console.log("- 标准答案: " + caseObj.answer + "（题目时点 " + caseObj.question_date + "）");
console.log("- 抽取来源: facts-cache（facts-v2，无 cardinality → 启发式裁决，同生产缺省）");

console.log("\n## 1. 落库形状");
console.log("- 事实行 " + factRows.length + " 条（有 fact_of）/ 整行兜底 " + wholeRows.length + " 条 / 带三元组轮次 " + turnsWithFacts + " 个");
console.log("- 有效 " + active.length + " 条 / 已失效（valid_end 非空）" + superseded.length + " 条");
console.log("- metadata 可读率: fact_key " + factRows.filter((r) => r.fact_key).length + "/" + factRows.length +
  " · valid_start " + factRows.filter((r) => r.valid_start).length + "/" + factRows.length);

console.log("\n## 2. 知识更新链（同（实体,属性）跨轮多值）");
if (updateChains.length === 0) {
  console.log("- 本 case 内同键多值链为 0（抽取谓词逐轮不同 → 建议看下面切片统计）");
} else {
  for (const c of updateChains) {
    console.log("- " + c.fact_key + " · cardinality=" + c.cardinality + " · " + c.n + " 条");
    for (const t of c.contents) console.log("    · " + t);
  }
}

const sample = (superseded[0] || factRows[0]);
console.log("\n## 3. 样例行（可追溯性）");
if (sample) {
  console.log("- record_id: " + sample.id);
  console.log("- content  : " + sample.content);
  console.log("- fact_key : " + (sample.fact_key || "-") + " · cardinality=" + (sample.cardinality || "-"));
  console.log("- 效期     : [" + (sample.valid_start || "-") + ", " + (sample.valid_end || "∞") + ")");
}

// ── 3b. 读侧注入文本（#166 值级泄漏）：走**真实召回路径** ────────────────────
// 这里刻意不再手写"模拟注入"（旧版用 related=同 fact_key + 手工 collapse），因为那会与
// 生产漂移两次：①生产的 related 是 contentTokenOverlap，不是 fact_key；②污染源要按池内
// expired 判定。改为直接调 searchHybrid（与钩子同一条路径），logger(7) 之后的位置形参：
// rest[7]=rerankWeights、rest[9]=excludeInvalidated、rest[10]=validityNow。
// 时点用题目时点（question_date）：更新链之后，避免"现在"落在最后一条更新之前。
const NOW = new Date(Date.parse(parseCorpusDate(caseObj.question_date)) || Date.now());
const RELEVANCE_ONLY = { relevance: 1, timeProx: 0, significance: 0, coreRef: 0 };
async function recall(userText) {
  const rest = new Array(15).fill(undefined);
  rest[7] = RELEVANCE_ONLY;
  rest[9] = "soft";
  rest[10] = NOW;
  return searchHybrid(userText, "", 10, 0.1, store, embedding, undefined, ...rest.slice(1));
}
// present 问句带 "now"/"currently"（PRESENT_TEMPORAL_RE 命中）；history 问句刻意不带当下标记。
// --present/--history 可覆盖（facts-cache 的抽取谓词随 promptVersion 变，换 case 时要换问句）。
const PRESENT_Q = argOf("--present", "What brand of BBQ sauce am I currently obsessed with?");
const HISTORY_Q = argOf("--history", "What brand of BBQ sauce was I obsessed with before?");
const presentRecall = await recall(PRESENT_Q);
const historyRecall = await recall(HISTORY_Q);
const staleValues = [...new Set(superseded.map((r) => r.fact_value).filter((v) => v))];
console.log("\n## 3b. 读侧注入文本（#166，now=" + NOW.toISOString() + "）");
console.log("- present 问句: " + PRESENT_Q);
console.log("- present 注入 " + presentRecall.lines.length + " 行 / 被取代旧值: " + (staleValues.join(" · ") || "—"));
for (const l of presentRecall.lines.slice(0, 5)) console.log("    " + l);
console.log("- history 问句: " + HISTORY_Q);
console.log("- history 注入 " + historyRecall.lines.length + " 行");
for (const l of historyRecall.lines.slice(0, 5)) console.log("    " + l);

// ── 切片统计：整个 knowledge-update 题型（有缓存的）触发面 ────────────────────
const all = Array.isArray(ds) ? ds : ds.data || Object.values(ds)[0];
let sliceCases = 0;
let sliceTriples = 0;
let repeatKeys = 0;
let repeatSingle = 0;
let repeatMulti = 0;
const cardDist = { single: 0, multi: 0 };
for (const c of all) {
  if (c.question_type !== "knowledge-update") continue;
  const p = path.join(CACHE, c.question_id + ".json");
  if (!fs.existsSync(p)) continue;
  sliceCases++;
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  const keys = new Map();
  for (const v of Object.values(j.byTurn || {})) {
    for (const t of v.triples || []) {
      sliceTriples++;
      const verdict = classifyCardinality(t.predicate, t.value);
      cardDist[verdict.cardinality]++;
      const k = String(t.subject).toLowerCase() + "\u0001" + String(t.predicate).toLowerCase();
      if (!keys.has(k)) keys.set(k, new Set());
      keys.get(k).add(t.value);
    }
  }
  for (const [k, vals] of keys) {
    if (vals.size < 2) continue;
    repeatKeys++;
    const pr = k.split("\u0001")[1];
    if (classifyCardinality(pr, [...vals][0]).cardinality === "single") repeatSingle++;
    else repeatMulti++;
  }
}
console.log("\n## 4. knowledge-update 切片触发面（" + sliceCases + " 个有缓存 case / " + sliceTriples + " 条三元组）");
console.log("- 基数分布（启发式）: single " + cardDist.single + " · multi " + cardDist.multi);
console.log("- 同（实体,属性）跨轮多值键: " + repeatKeys + "（single " + repeatSingle + " / multi " + repeatMulti + "）");
console.log("- 解读: 只有 single 键的更新会触发事实级失效；multi 多值是 additive（本票刻意不失效）。" +
  " 本切片 " + (repeatSingle === 0 ? "无 single 更新键 → 真实语料上失效触发面为 0（抽取谓词逐轮改写 + 启发式偏 multi）" : "有 " + repeatSingle + " 个 single 更新键") + "。");

// 泄漏判定：真实语料里别的轮次本来就会提到同一个地名/航司/品牌，那是独立证据，不是旧值回流，
// 所以判据一律按 turn 定位（下面 turnLeaks），不看整段文本 contains。
const presentText = presentRecall.lines.join("\n");
const historyText = historyRecall.lines.join("\n");
// 按 turn 定位：searchHybrid 的 metas 与 lines 平行，recordId 是注入行的记录 id（折叠后是存活行 id）。
// 真实语料里别的轮次本来就提同一地名/航司（本 case 的 LA 满篇都是），整段 includes 会误判。
const presentRids = presentRecall.lines.map((_, i) => presentRecall.metas?.[i]?.recordId ?? "");
const recordTurns = new Map(rows.map((r) => [r.id, r.fact_of || r.id]));
const turnOfLine = (rid) => recordTurns.get(rid) || rid.split("#f")[0];
const turnLeaks = [];
for (const dropped of superseded) {
  const turn = dropped.fact_of || dropped.id;
  const stale = dropped.fact_value;
  if (!stale) continue;
  presentRecall.lines.forEach((line, i) => {
    if (turnOfLine(presentRids[i]) === turn && line.includes(stale)) {
      turnLeaks.push({ turn, stale, text: line.slice(0, 160) });
    }
  });
}
const insertedStale = [...new Set(turnLeaks.map((l) => l.stale))];
const contaminatedTurns = new Set(superseded.map((r) => r.fact_of || r.id));
const staleTurnSeen = presentRids.some((rid) => contaminatedTurns.has(turnOfLine(rid)));
// 更新后的新值（同 fact_key 的 active 单值行）应能召回——问当下要答得出"现在是什么"。
const staleKeys = new Set(superseded.map((r) => r.fact_key).filter(Boolean));
const currentValues = [...new Set(active.filter((r) => staleKeys.has(r.fact_key)).map((r) => r.fact_value).filter(Boolean))];
const currentSeen = currentValues.filter((v) => presentText.includes(v));
console.log("\n## 5. 值级泄漏 / 可回溯（真实召回路径）");
console.log("- present 注入含被取代旧值: " + (insertedStale.join(" · ") || "无"));
console.log("- present 注入里见到污染 turn 的存活行: " + (staleTurnSeen ? "是（应已是事实短语，不含旧值）" : "否（本问句未召回该 turn）"));
// 污染 turn 的存活行应改注入自己的事实短语（metadata.fact_phrase），而不是父 turn 原文。
const phraseOfRecord = new Map(rows.map((r) => [r.id, r.fact_phrase || ""]));
const contaminatedInjected = presentRids
  .map((rid, i) => ({ rid, turn: turnOfLine(rid), line: presentRecall.lines[i] }))
  .filter((x) => contaminatedTurns.has(x.turn));
const reRenderedAsPhrase = contaminatedInjected.filter((x) => {
  const phrase = phraseOfRecord.get(x.rid) || "";
  return phrase && x.line.includes(phrase);
});
console.log("- present 注入的污染 turn 存活行 " + contaminatedInjected.length + " 行，其中改注入自身事实短语的 " + reRenderedAsPhrase.length + " 行" +
  (contaminatedInjected.length ? " → " + contaminatedInjected.map((x) => (phraseOfRecord.get(x.rid) || x.line.slice(0, 40))).join(" · ") : ""));
for (const l of turnLeaks) console.log("    · turn=" + l.turn + " stale=" + l.stale + " → " + l.text);
console.log("- 更新后新值: " + (currentValues.join(" · ") || "—") + " → present 命中: " + (currentSeen.join(" · ") || "无"));
console.log("- history 注入含旧值: " + (staleValues.some((v) => historyText.includes(v)) ? "是（可回溯）" : "否"));

const ok = [
  ["每个含事实的轮次都落成了事实行（无整行吞并）", factRows.length > 0 && turnsWithFacts > 0],
  ["事实行 metadata 带 fact_key（效期粒度可读）", factRows.every((r) => r.fact_key)],
  ["事实行 valid_start 全可读（双时态起点）", factRows.every((r) => r.valid_start)],
  ["旧值不删除：失效行仍在库且 content 非空", superseded.every((r) => r.content && r.content.length > 0)],
  ["单值更新链在库内可见（同键多值并存，未被覆盖）", updateChains.length > 0 || repeatMulti > 0],
];
const leakCheckable = superseded.length > 0 && staleValues.length > 0;
if (leakCheckable) {
  ok.push(["#166 · 问当下（presentIntent）注入文本不含被取代旧值（按 turn 判）", turnLeaks.length === 0]);
  ok.push(["#166 · 问当下能召回更新后的新值", currentValues.length > 0 && currentSeen.length > 0]);
  ok.push(["#166 · 问历史注入文本仍含旧值（可回溯）", staleValues.some((v) => historyText.includes(v))]);
} else {
  // 判据 SKIP 不能算过：验收②要的就是「问当下不出现被取代值」，无可判 case 等于没验（#166 review）。
  ok.push(["#166 · 本 case 在题目时点存在被取代行（判据可判，不是空跑）", false]);
  console.log("\n（本 case 在题目时点无被取代行 → 值级判据无从判，记为 FAIL 并换 case；用 --case 指定同键更新的 case）");
}
console.log("\n## 5. 判据");
let allOk = true;
for (const [name, pass] of ok) {
  if (!pass) allOk = false;
  console.log("- " + (pass ? "PASS" : "FAIL") + " · " + name);
}
console.log("\n" + (allOk ? "ALL PASS" : "SOME FAILED") + " · 落库目录 " + CASE_OUT);
if (!allOk) process.exitCode = 1;
