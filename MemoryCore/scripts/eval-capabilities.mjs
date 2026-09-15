/**
 * eval-capabilities.mjs — P1 Task 2：三信号 Lane2 能力道评估脚本
 *
 * 依据：/opt/tdai/sdd-workspace/phase1/task-2-brief.md（数值与签名逐字）；
 *       spec docs/superpowers/specs/2026-09-15-memory-evolution-design.md §6.1
 *       （三信号分层：构造式真值硬门 / 不变量硬门 / 判官软轨）。
 * 语料：Task 1 eval-capabilities-fixture.mjs（buildFixtures / seedStore，已过审接口）。
 *
 * 四能力探针 + 两不变量（全部走临时网关 HTTP /v3/atomic/search 生产同构链路）：
 *   time          构造式真值硬门：时间锚 query → 返回项 occurred_at 全落 parseTimeWindow 窗内
 *   session       构造式真值硬门：同主题跨 session query → 去重 session 数 ≥ minSessions
 *   update        构造式真值硬门（expectedRed=true，P1 known-FAIL）：new 应排 old 之前
 *                 ——P1 无失效语义，基线预期红；归档记录 new/old 实际名次作基线
 *   abstain       拒答软门（GOLD-EVO 修正）：域外（零语料交集）query 零结果，或 top1 < ABSTAIN_FLOOR=0.5 绝对地板
 *   determinism   不变量：同 query 双跑（各自独立 session）投影逐位一致
 *   tenantClosure 不变量：跨租户三元组 query → 0 结果（正控：fixture 租户 > 0）
 *
 * 隔离纪律（承 recall-anchor.mjs 同款）：
 *   - 生产 tdai-gateway.yaml 全程只读（readFileSync → YAML.parse），绝不写入；
 *   - 临时网关端口 8423（避开生产 8420 / Knowledge 8421 / anchor 8422 / Panel 8123），自起自停；
 *   - 临时 dataDir = fs.mkdtempSync(os.tmpdir())，测后 rm -rf；绝不触碰生产 /data/tdai-memory；
 *   - 排序路径零变更：本脚本不 import/改写 memory-search.ts / recall-signals.ts / auto-recall。
 *
 * 临时 yaml 相对生产值的关断（均登记进归档 gateway.deviations）：
 *   - lifecycle/capture/extraction/skill.extraction=false：最小化临时网关写入面（recall-anchor 同款）；
 *   - memory.recall.queryExpansion.enabled=false：LLM 语义扩展每次外呼不可复现，破坏确定性
 *     不变量（E1.4 退化道只在失败时生效，不覆盖成功路径）；
 *   - memory.recall.exploreSlot=false：探索位末席组成依赖 recall_count（召回 bump 跨 pass 漂移），
 *     破坏"同 query 双跑逐位一致"。
 *
 * 执行顺序（brief Step 2 逐字）：
 *   boot 网关（建 schema）→ 停网关 → seedStore（store 类实例直写 temp DB，避开跨进程写）→
 *   再 boot 网关 → HTTP 探针 → 归档 → 自停。
 *
 * 租户注记：Task 1 records 未带隔离三元组（upsertL1 落 DEFAULT_ISOLATION_ID 桶）。
 * 本脚本在播种前向 records 注入 brief Step 1 指定的 fixture 租户三元组
 * { team-fix / usr-fix / agt-fix }（upsertL1 消费 record.teamId/userId/agentId，
 * sqlite.ts:1596-1598），不改 fixture 文件——主探针与正控走该租户，跨租户探针用全维度
 * 不同的 team-other 三元组。/v3/atomic/search 返回项无 session_id 字段
 * （v2-router.ts AtomicSearchHit 映射），session 探针从 temp DB readOnly 直读
 * l1_records.session_id 做旁路富化（自有临时库，只读，与排序路径零交集）。
 *
 * 运行：cd MemoryCore && sudo -u tdai node --import tsx scripts/eval-capabilities.mjs
 * exit code：全过=0；仅 expectedRed 失败=0（baseline:true）；意外失败=1
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import YAML from "yaml";

// ── 生产同构模块（tsx 直跑，单一源不重写）────────────────────────────
const { buildFixtures, seedStore } = await import("./eval-capabilities-fixture.mjs");
const { VectorStore } = await import("../src/core/store/sqlite.ts");
const { parseTimeWindow, inTimeWindow } = await import("../src/core/tools/content-time-window.ts");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORE_DIR = path.resolve(__dirname, "..");
const RUNS_DIR = path.resolve(CORE_DIR, "..", "docs", "superpowers", "evals", "capabilities", "runs");
const PROD_YAML = path.join(CORE_DIR, "tdai-gateway.yaml"); // 只读
const PORT = 8423;
const API_BASE = `http://127.0.0.1:${PORT}`;
const THEME_INDEX = 0;
/** fixture 租户三元组（brief Step 1 逐字）——播种前注入 records，主探针全走该租户。 */
const FIXTURE_TENANT = { team_id: "team-fix", user_id: "usr-fix", agent_id: "agt-fix" };
/** 跨租户不变量探针：与 fixture 租户全维度不同。 */
const CROSS_TENANT = { team_id: "team-other", user_id: "usr-other", agent_id: "agt-other" };
/** 时间探针 query（brief 探针块逐字）。fixture expectations.timeQueries 无时间锚
 *  （parseTimeWindow → null，宁缺毋滥不过滤），无法承载窗口断言，故用 brief 逐字清单。 */
const TIME_QUERIES = ["上个月的部署安排", "6月做了什么"];
const SEARCH_LIMIT = 8;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[eval-capabilities]", ...a);
const loud = (...a) => console.error("[eval-capabilities][RED-CARD]", ...a);

/** 执行顺序实录（进归档 executionOrder，报告契约要求）。 */
const execLog = [];
function mark(step) {
  execLog.push(`${new Date().toISOString()} ${step}`);
  log(step);
}

// ── 临时 yaml（生产只读 → tmpdir 改写副本）──────────────────────────
function buildTempYaml(ts, dataDir) {
  const cfg = YAML.parse(fs.readFileSync(PROD_YAML, "utf8")); // 生产 yaml 只读
  cfg.server.port = PORT;
  cfg.data.baseDir = dataDir;
  // 结伴生关闭（最小化临时网关写入面，recall-anchor 同款）
  if (cfg.memory) {
    if (cfg.memory.lifecycle) cfg.memory.lifecycle.enabled = false;
    if (cfg.memory.capture) cfg.memory.capture.enabled = false;
    if (cfg.memory.extraction) cfg.memory.extraction.enabled = false;
  }
  if (cfg.skill && cfg.skill.extraction) cfg.skill.extraction.enabled = false;
  // 确定性关断（理由见文件头；偏离生产工作点，归档登记）
  if (cfg.memory?.recall) {
    cfg.memory.recall.queryExpansion = { ...(cfg.memory.recall.queryExpansion ?? {}), enabled: false };
    cfg.memory.recall.exploreSlot = false;
  }
  const out = path.join(os.tmpdir(), `eval-capabilities-${ts}.yaml`);
  fs.writeFileSync(out, YAML.stringify(cfg), "utf8");
  return out;
}

// ── 临时网关自起自停（照抄 recall-anchor.mjs:97-118）─────────────────
let gw = null;
async function startGw(yamlFile) {
  gw = spawn(process.execPath, ["--import", "tsx", "src/gateway/server.ts"], {
    cwd: CORE_DIR,
    env: { ...process.env, TDAI_GATEWAY_CONFIG: yamlFile },
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
  });
  gw.unref();
  for (let i = 0; i < 45; i++) {
    await sleep(1000);
    try {
      const h = await (await fetch(`${API_BASE}/health`)).json();
      if (h.status === "ok") return;
    } catch { /* not up yet */ }
  }
  throw new Error(`temp gateway on :${PORT} not healthy in 45s`);
}
function stopGw() {
  if (!gw) return;
  try { process.kill(-gw.pid); } catch { /* already gone */ }
  try { gw.kill(); } catch { /* already gone */ }
  gw = null;
}

// ── 检索调用（/v3/atomic/search 生产同构链路）────────────────────────
async function search(query, sessionId, iso, apiKey) {
  const r = await fetch(`${API_BASE}/v3/atomic/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "x-tdai-service-id": "default",
    },
    body: JSON.stringify({ query, limit: SEARCH_LIMIT, session_id: sessionId, ...iso }),
  });
  if (!r.ok) throw new Error(`atomic/search HTTP ${r.status}: ${await r.text().catch(() => "")}`);
  const j = await r.json();
  if (j?.code !== 0) throw new Error(`atomic/search code=${j?.code}: ${j?.message}`);
  return (j?.data?.items ?? []).map((x) => ({
    id: x.id,
    score: x.score,
    type: x.type,
    content: x.content,
    occurred_at: x.occurred_at ?? null,
    metadata: x.metadata ?? {},
  }));
}

/** temp DB readOnly 直读：record_id → session_id（返回项无 session_id，旁路富化）。 */
function loadSessionMap(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT record_id, session_id FROM l1_records WHERE team_id = ? AND user_id = ? AND agent_id = ?")
      .all(FIXTURE_TENANT.team_id, FIXTURE_TENANT.user_id, FIXTURE_TENANT.agent_id);
    return new Map(rows.map((r) => [r.record_id, r.session_id]));
  } finally {
    db.close();
  }
}

const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return null;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

/** 确定性比较投影：[id, score, occurred_at] 逐位（不含 metadata——recall bump 会漂移）。 */
const detProjection = (items) => JSON.stringify(items.map((i) => [i.id, i.score, i.occurred_at]));

// ── 主流程 ──────────────────────────────────────────────────────────
async function main() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  // 生产 yaml server.apiKey（YAML.parse 取值，避开注释占位符；recall-anchor 同款）
  const prodCfg = YAML.parse(fs.readFileSync(PROD_YAML, "utf8")); // 只读
  const apiKey = prodCfg?.server?.apiKey;
  if (typeof apiKey !== "string" || !apiKey) throw new Error("server.apiKey not found in production yaml (read-only)");

  mark(`buildFixtures(${THEME_INDEX}) 构造语料与期望`);
  const fixture = buildFixtures(THEME_INDEX);
  const expectations = fixture.expectations;
  // 播种前注入 fixture 租户三元组（brief Step 1；upsertL1 消费 record.teamId/userId/agentId）
  const records = fixture.records.map((r) => ({
    ...r,
    teamId: FIXTURE_TENANT.team_id,
    userId: FIXTURE_TENANT.user_id,
    agentId: FIXTURE_TENANT.agent_id,
  }));
  const fixtureSha = crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(__dirname, "eval-capabilities-fixture.mjs")))
    .digest("hex");

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-cap-"));
  const dbPath = path.join(dataDir, "vectors.db");
  const yamlFile = buildTempYaml(ts, dataDir);
  const deviations = [
    "lifecycle/capture/extraction/skill.extraction=false（最小写入面，recall-anchor 同款）",
    "memory.recall.queryExpansion.enabled=false（LLM 外呼破坏确定性不变量）",
    "memory.recall.exploreSlot=false（探索位组成依赖 recall_count，跨 pass 漂移破坏逐位一致）",
  ];

  let exitCode = 1;
  try {
    // ── Step 2 执行顺序（brief 逐字）：boot#1 建 schema → 停 → seed → boot#2 → 探针 ──
    mark(`boot 临时网关 #1（建 schema，port=${PORT}，dataDir=${dataDir}）`);
    await startGw(yamlFile);
    mark("停网关 #1");
    stopGw();
    await sleep(1500);

    mark(`seedStore 直写 temp DB（VectorStore(dbPath, 0) BM25-only 道，${records.length} 条）`);
    const store = new VectorStore(dbPath, 0);
    await store.init();
    let seeded = 0;
    try {
      seeded = await seedStore(store, records);
      // GROW-EVO P2 不变量数据：fx0-noise-01 预失效（valid_end=2026-01-01，默认召回必须排除）
      const invOk = store.invalidateL1?.("fx0-noise-01", "2026-01-01T00:00:00.000Z");
      if (!invOk) throw new Error("invalidation seed failed（fx0-noise-01）");
      // Task 5：冲突对 old 预失效——模拟 dedup conflict 的生产等价效果（§2.2 方向性守卫下
      // 新 observed 记忆会自动失效旧记忆；fixture 直写 store 故显式模拟）
      for (const r of records) {
        if (!/-conflict-[123]-old$/.test(r.id)) continue;
        const newRec = records.find((x) => x.id === r.id.replace(/-old$/, "-new"));
        const ve = newRec?.occurred_at ?? "2026-09-01T00:00:00.000Z";
        if (!store.invalidateL1?.(r.id, ve)) throw new Error(`invalidation seed failed（${r.id}）`);
      }
    } finally {
      store.close();
    }
    if (seeded !== records.length) throw new Error(`seeded ${seeded}/${records.length} — 播种不完整`);

    const sessionMap = loadSessionMap(dbPath);
    if (sessionMap.size !== records.length) {
      throw new Error(`readOnly 复核 team-fix 行数=${sessionMap.size} ≠ 播种数 ${records.length} — 租户注入失效`);
    }
    mark(`seed 完成 ${seeded} 条；readOnly 复核 fixture 租户行数=${sessionMap.size} ✓`);

    mark("boot 临时网关 #2（同一 temp dataDir，验证 store 直写跨进程可见）");
    await startGw(yamlFile);

    // 正控：fixture 租户必须能检索到（dataDir 一致性 + 租户注入生效）
    const pc = await search(expectations.sessionProbe.query, `eval-cap-pc-${ts}`, FIXTURE_TENANT, apiKey);
    if (pc.length === 0) throw new Error("正控 0 hits — temp dataDir 不一致或租户注入失效");
    mark(`正控通过：fixture 租户 ${pc.length} hits`);

    // ── 探针 pass 1（独立 session，防 E3 session 复用缓存跨探针污染）──
    const p1 = `eval-cap-p1-${ts}`;
    const firstByQuery = new Map();

    // ① time 探针（构造式真值硬门）
    const time = [];
    for (const q of TIME_QUERIES) {
      const win = parseTimeWindow(q);
      const items = await search(q, p1, FIXTURE_TENANT, apiKey);
      firstByQuery.set(q, items);
      const winParsed = win !== null;
      const allIn = winParsed && items.every((i) => inTimeWindow(i.occurred_at, win));
      time.push({
        query: q,
        window: win,
        hitCount: items.length,
        nonEmpty: items.length > 0,
        allInWindow: allIn,
        passed: winParsed && allIn,
        ids: items.map((i) => i.id),
      });
    }
    const timePassed = time.every((t) => t.passed);
    if (!timePassed) loud(`time 探针失败：${JSON.stringify(time)}`);
    mark(`time 探针：${timePassed ? "PASS" : "FAIL"}（${time.map((t) => `${t.query}→${t.hitCount}hits`).join(" / ")}）`);

    // ② session 探针（构造式真值硬门；session_id 旁路富化自 temp DB readOnly）
    const sq = expectations.sessionProbe.query;
    const sItems = await search(sq, p1, FIXTURE_TENANT, apiKey);
    firstByQuery.set(sq, sItems);
    const sEnriched = sItems.map((i) => ({ ...i, session_id: sessionMap.get(i.id) ?? null }));
    const distinctSessions = new Set(sEnriched.map((i) => i.session_id).filter(Boolean)).size;
    const sessionProbe = {
      query: sq,
      minSessions: expectations.sessionProbe.minSessions,
      hitCount: sItems.length,
      distinctSessions,
      sessions: [...new Set(sEnriched.map((i) => i.session_id).filter(Boolean))],
      passed: distinctSessions >= expectations.sessionProbe.minSessions,
      items: sEnriched.map((i) => ({ id: i.id, session_id: i.session_id, score: i.score })),
    };
    if (!sessionProbe.passed) loud(`session 探针失败：${JSON.stringify(sessionProbe)}`);
    mark(`session 探针：${sessionProbe.passed ? "PASS" : "FAIL"}（${distinctSessions} sessions ≥ ${expectations.sessionProbe.minSessions}）`);

    // ③ update 探针（GROW-EVO P2 转硬门）：失效语义闭环判据 = old 被失效排除（不在
    // 结果中）、new 在列。P1 时代的"new 排 old 前"判据退役（排除语义下 old 恒 -1）。
    const uq = expectations.updateProbe.query;
    const uItems = await search(uq, p1, FIXTURE_TENANT, apiKey);
    firstByQuery.set(uq, uItems);
    const newRank = uItems.findIndex((i) => i.id === expectations.updateProbe.newId);
    const oldRank = uItems.findIndex((i) => i.id === expectations.updateProbe.oldId);
    const updateOrdered = newRank !== -1 && oldRank === -1;
    const updateProbe = {
      query: uq,
      newId: expectations.updateProbe.newId,
      oldId: expectations.updateProbe.oldId,
      newRank, // -1 = 未进前 SEARCH_LIMIT
      oldRank, // -1 = 已被失效排除（预期）
      expectedRed: false,
      ordered: updateOrdered,
      knownFAIL: !updateOrdered, // 红牌 = 与 P1 基线一致（无失效语义）
      passed: updateOrdered,
      items: uItems.map((i) => ({ id: i.id, score: i.score, occurred_at: i.occurred_at, content: i.content })),
    };
    if (updateOrdered) {
      log(`update 探针：PASS（失效语义闭环：old 被排除、new 在列）`);
    } else {
      log(`update 探针：FAIL（new=${newRank} old=${oldRank}——失效排除未生效）`);
    }
    mark(`update 探针：${updateOrdered ? "PASS" : `FAIL（new=${newRank}, old=${oldRank}）`}`);

    // ④ abstain 探针（拒答软门，GOLD-EVO 修正 2026-09-15）：语义 = 与全语料零交集的
    // 域外 query 应空/低分。首版误用 noiseQueries（噪声主题在 fixture 里有对应记录，
    // BM25 强命中 ~0.9，相对门结构上不可过）——改 OOC 域外 query + 绝对地板分；
    // top1P50 降级为信息字段。
    // 候选均经临时库实测零 BM25 命中（词级零交集；更换 query 须先实测，2026-09-15）
    const OOC_QUERIES = [
      "量子引力波探测的最新进展",
      "深海热液喷口的化能合成生态",
      "马丘比丘遗址的海拔高度",
      "候鸟地磁导航的机制假说",
      "宋代汝窑天青釉的烧制工艺",
    ];
    const ABSTAIN_FLOOR = 0.5; // 绝对地板分：域外命中应为零或极低分（强词面命中恒 ~0.9）
    const top1s = [
      ...time.map((t, idx) => firstByQuery.get(TIME_QUERIES[idx])[0]?.score).filter((v) => typeof v === "number"),
      sItems[0]?.score,
      uItems[0]?.score,
    ].filter((v) => typeof v === "number");
    const top1P50 = median(top1s); // 信息字段（不作门槛）
    const abstain = [];
    for (const q of OOC_QUERIES) {
      const items = await search(q, p1, FIXTURE_TENANT, apiKey);
      firstByQuery.set(q, items);
      const top1 = items[0]?.score ?? null;
      abstain.push({
        query: q,
        hitCount: items.length,
        top1,
        passed: !items.length || (typeof top1 === "number" && top1 < ABSTAIN_FLOOR),
      });
    }
    const abstainPassed = abstain.every((a) => a.passed);
    if (!abstainPassed) loud(`abstain 探针失败：${JSON.stringify(abstain)}（ABSTAIN_FLOOR=${ABSTAIN_FLOOR}）`);
    mark(`abstain 探针：${abstainPassed ? "PASS" : "FAIL"}（FLOOR=${ABSTAIN_FLOOR}，${abstain.filter((a) => a.passed).length}/${abstain.length} query 过）`);

    // ⑤ tenantClosure 不变量：跨租户 query → 0 结果（正控已由 pc 承担）
    const crossItems = await search(sq, `eval-cap-cross-${ts}`, CROSS_TENANT, apiKey);
    const tenantClosure = {
      crossTenant: CROSS_TENANT,
      crossHitCount: crossItems.length,
      positiveControlHits: pc.length,
      passed: crossItems.length === 0 && pc.length > 0,
    };
    if (!tenantClosure.passed) loud(`tenantClosure 不变量失败：${JSON.stringify(tenantClosure)}`);
    mark(`tenantClosure 不变量：${tenantClosure.passed ? "PASS" : "FAIL"}（跨租户 ${crossItems.length} hits，正控 ${pc.length} hits）`);

    // ⑤b invalidationExclusion 不变量（GROW-EVO P2 §2.3）：已失效记忆（fx0-noise-01，
    // valid_end=2026-01-01）必须被默认召回排除——按其内容前缀检索 → 0 hits
    const invRec = records.find((r) => r.id === "fx0-noise-01");
    const invQuery = (invRec?.content ?? "").slice(0, 6);
    const invItems = await search(invQuery, p1, FIXTURE_TENANT, apiKey);
    const invalidationExclusion = {
      query: invQuery,
      hitCount: invItems.length,
      passed: invItems.length === 0,
    };
    if (!invalidationExclusion.passed) loud(`invalidationExclusion 不变量失败：失效记录仍被召回 ${JSON.stringify(invItems.slice(0, 2))}`);
    mark(`invalidationExclusion 不变量：${invalidationExclusion.passed ? "PASS" : "FAIL"}（${invQuery} → ${invItems.length} hits）`);

    // ⑤c timeTravel 探针（GROW-EVO P2.1 §2.4）：/v3/recall + time_point——"当时有效"语义。
    // 冲突对 fx0-conflict-1：old（阿里云，valid_end=2026-08-01T10:00Z=new.occurred_at）。
    // tp=2026-07-01（失效前）→ old 应在注入块；缺省（现在）→ old 必须被排除。
    const recallProbe = async (tp) => {
      const r = await fetch(`${API_BASE}/v3/recall`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, "x-tdai-service-id": "default" },
        body: JSON.stringify({ query: expectations.updateProbe.query, session_id: p1, ...FIXTURE_TENANT, ...(tp ? { time_point: tp } : {}) }),
      });
      if (!r.ok) throw new Error(`recall HTTP ${r.status}: ${await r.text().catch(() => "")}`);
      const j = await r.json();
      if (j?.code !== 0) throw new Error(`recall code=${j?.code}: ${j?.message}`);
      return j?.data?.block ?? "";
    };
    const oldRec = records.find((r) => r.id === expectations.updateProbe.oldId);
    const oldContent = oldRec?.content ?? "";
    const pastBlock = await recallProbe("2026-07-01T00:00:00.000Z");
    const nowBlock = await recallProbe();
    const timeTravel = {
      pastContainsOld: pastBlock.includes(oldContent),
      nowExcludesOld: !nowBlock.includes(oldContent),
      passed: pastBlock.includes(oldContent) && !nowBlock.includes(oldContent),
    };
    if (!timeTravel.passed) loud(`timeTravel 探针失败：${JSON.stringify(timeTravel)}`);
    mark(`timeTravel 探针：${timeTravel.passed ? "PASS" : "FAIL"}（tp 过去含 old=${timeTravel.pastContainsOld}，现在排除 old=${timeTravel.nowExcludesOld}）`);

    // ⑥ determinism 不变量：同 query 双跑（pass2 独立 session）逐位一致
    const p2 = `eval-cap-p2-${ts}`;
    const detMismatches = [];
    const detQueries = [...firstByQuery.keys()];
    for (const q of detQueries) {
      const again = await search(q, p2, FIXTURE_TENANT, apiKey);
      if (detProjection(again) !== detProjection(firstByQuery.get(q))) {
        detMismatches.push({
          query: q,
          pass1: detProjection(firstByQuery.get(q)),
          pass2: detProjection(again),
        });
      }
    }
    const determinism = {
      method: "同 query 双跑（各自独立 session，投影 [id, score, occurred_at] 逐位一致）",
      queryCount: detQueries.length,
      mismatchCount: detMismatches.length,
      passed: detMismatches.length === 0,
      mismatches: detMismatches,
    };
    if (!determinism.passed) loud(`determinism 不变量失败：${detMismatches.length}/${detQueries.length} query 双跑不一致`);
    mark(`determinism 不变量：${determinism.passed ? "PASS" : "FAIL"}（${detQueries.length} query 双跑）`);

    // ── 裁决（brief Step 3 exit code 契约）────────────────────────────
    const knownFAIL = !updateOrdered;
    const unexpectedFails = [];
    if (!timePassed) unexpectedFails.push("time");
    if (!sessionProbe.passed) unexpectedFails.push("session");
    if (!abstainPassed) unexpectedFails.push("abstain");
    if (!determinism.passed) unexpectedFails.push("determinism");
    if (!tenantClosure.passed) unexpectedFails.push("tenantClosure");
    if (!invalidationExclusion.passed) unexpectedFails.push("invalidationExclusion");
    if (!timeTravel.passed) unexpectedFails.push("timeTravel");
    const allPass = unexpectedFails.length === 0 && !knownFAIL;
    const baselineOnly = unexpectedFails.length === 0 && knownFAIL;
    exitCode = allPass || baselineOnly ? 0 : 1;

    // ── 归档（brief Step 2 顺序：探针后、自停前）──────────────────────
    mark(`归档 → ${RUNS_DIR}/${ts}.capabilities.json`);
    const archive = {
      schema: "capabilities-eval/v1",
      generated_at: new Date().toISOString(),
      themeIndex: THEME_INDEX,
      fixture: {
        file: "MemoryCore/scripts/eval-capabilities-fixture.mjs",
        sha256: fixtureSha,
        records: records.length,
        seeded,
        tenant: FIXTURE_TENANT,
      },
      gateway: { port: PORT, tempYaml: yamlFile, dataDir, deviations },
      executionOrder: execLog,
      stats: { realQueryTop1: top1s, top1P50 },
      probes: {
        time,
        session: sessionProbe,
        update: updateProbe,
        abstain,
        invariants: { determinism, tenantClosure, invalidationExclusion, timeTravel },
      },
      verdict: {
        allPass,
        baseline: baselineOnly,
        unexpectedFails,
        knownFAIL: knownFAIL ? { probe: "update", reason: "P1 无失效语义（brief expectedRed）" } : null,
      },
    };
    fs.mkdirSync(RUNS_DIR, { recursive: true });
    const runFile = path.join(RUNS_DIR, `${ts}.capabilities.json`);
    fs.writeFileSync(runFile, JSON.stringify(archive, null, 2), "utf8");

    log("── 逐探针摘要 ──");
    log(`time          ${timePassed ? "PASS" : "FAIL"}  (${time.map((t) => `${t.hitCount}hits/inWindow`).join(", ")})`);
    log(`session       ${sessionProbe.passed ? "PASS" : "FAIL"}  (${distinctSessions} sessions, min ${expectations.sessionProbe.minSessions})`);
    log(`update        ${updateOrdered ? "PASS（基线翻绿）" : "known-FAIL（基线）"}  (new=${newRank}, old=${oldRank})`);
    log(`abstain       ${abstainPassed ? "PASS" : "FAIL"}  (top1P50=${top1P50})`);
    log(`determinism   ${determinism.passed ? "PASS" : "FAIL"}  (${detQueries.length} queries 双跑)`);
    log(`tenantClosure ${tenantClosure.passed ? "PASS" : "FAIL"}`);
    log(`verdict: ${allPass ? "ALL PASS" : baselineOnly ? "BASELINE（仅 known-FAIL 红）" : `UNEXPECTED FAIL: ${unexpectedFails.join(", ")}`} | exit=${exitCode}`);
    log(`archive: ${runFile}`);

    mark(`自停临时网关 + 清理 temp（exit=${exitCode}）`);
    return { exitCode, runFile };
  } finally {
    stopGw();
    await sleep(1500);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.rmSync(yamlFile, { force: true }); } catch { /* best effort */ }
  }
}

main()
  .then(({ exitCode }) => process.exit(exitCode))
  .catch((err) => {
    loud(`FATAL: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exit(1);
  });
