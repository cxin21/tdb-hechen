/**
 * Task GROW 同形验证：价值锚自生长（调度器挂钩 + 钉住/挤出状态机 + 护栏四件）。
 *
 * 断言组（brief §5 验收契约）：
 *   1. 状态机：active→retired→restore→pinned 全转换（真库）；vetoed 拒绝族；
 *      软删除语义（delete → vetoed，再删 false，includeRetired 不可见，upsert 重添复活）。
 *   2. 自生长：证据门槛（4 条不提/5 条提）/ 生长上限（+2）/ 挤出最弱（pinned 豁免）/
 *      veto 永不重提（dedup 查全态）。
 *   3. 调度触发：interval 未到不跑 / 语料无新增不跑；轮次完成后状态持久化。
 *   4. handler 链路：pin/retire/restore 200/404/400 + /core-memory/read include_retired 出参。
 *   5. 兼容登记（预期行为变更）：listValues 默认 active-only（退休/否决锚退出匹配面）。
 *
 * 用法（在 MemoryCore 目录下）：
 *   node --import tsx scripts/verify-grow.ts
 *
 * 只用自建临时库，不连任何线上资源、不碰生产数据目录（D:/tdai-data/ 不触碰）；
 * 跑完自动清理临时目录。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { VectorStore } from "../src/core/store/sqlite.js";
import { runAnchorGrowth } from "../src/core/lifecycle/anchor-growth.js";
import {
  handleCoreMemoryValuesPin,
  handleCoreMemoryValuesRetire,
  handleCoreMemoryValuesRestore,
  handleCoreMemoryRead,
} from "../src/gateway/v2-router.js";
import type { MemoryRecord } from "../src/core/record/l1-writer.js";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`);
    fail++;
  }
}

const NOW = new Date("2026-09-10T12:00:00.000Z");
const now = () => NOW;
const LOG = { debug() {}, info() {}, warn() {}, error() {} };
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();

function mkRecord(id: string, content: string): MemoryRecord {
  return {
    id,
    content,
    type: "episodic",
    priority: 0,
    scene_name: "t",
    source_message_ids: [],
    metadata: {},
    timestamps: ["2026-09-01T00:00:00Z"],
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    version: 0,
    sessionKey: "k",
    sessionId: "s",
  } as MemoryRecord;
}

function newStore(dir: string, name: string): VectorStore {
  const store = new VectorStore(path.join(dir, `${name}.db`), 0);
  const res = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级（环境问题，非行为断言）：${JSON.stringify(res)}`);
  return store;
}

/** 语料：n 条含 label 的 L1 记忆（growth 语料计数=全量条数）。 */
async function seedCorpus(store: VectorStore, label: string, n: number, idPrefix = "c"): Promise<number> {
  for (let i = 0; i < n; i++) {
    await store.upsertL1(mkRecord(`${idPrefix}-${label}-${i}`, `第${i}条 关于${label}的记忆`));
  }
  return n;
}

function runner(reply: string) {
  return { run: async () => reply };
}

// ── 断言组 1：状态机全转换（真库）───────────────────────────────────

async function testStateMachine(tmpDir: string): Promise<void> {
  console.log("\n断言组 1 — 状态机：active→retired→restore→pinned 全转换 + veto 拒绝族 + 软删除语义");
  const store = newStore(tmpDir, "state-machine");

  // active → pinned → retired → restore（GROW 转换表正向路径）
  store.upsertValue("v1", "锚一", 0.8, "verify");
  check("1a 新建行默认 active/manual/pinned=0", (() => { const r = store.listValues()[0]!; return r.state === "active" && r.origin === "manual" && r.pinned === 0; })(), JSON.stringify(store.listValues()));
  check("1b pin(true) → true + pinned=1", store.setValuePinned("v1", true) && store.listValues()[0]!.pinned === 1);
  check("1c retire → true + state=retired（默认读面消失）", store.retireValue("v1") && store.listValues().length === 0);
  check("1d includeRetired 读面可见 retired", store.listValues(undefined, { includeRetired: true })[0]?.state === "retired");
  check("1e restore → true + state=active（pinned 保留）", store.restoreValue("v1") && store.listValues()[0]!.state === "active" && store.listValues()[0]!.pinned === 1);
  check("1f pin(false) → true + pinned=0", store.setValuePinned("v1", false) && store.listValues()[0]!.pinned === 0);
  check("1g active 行 restore → false（0 行变更）", store.restoreValue("v1") === false);
  check("1h 不存在行 pin/retire/restore → false", !store.setValuePinned("ghost", true) && !store.retireValue("ghost") && !store.restoreValue("ghost"));

  // 软删除语义（S1 delete 行为变更，登记）
  store.upsertValue("v2", "锚二", 0.6, "verify");
  check("1i delete → true + 行保留 state=vetoed（软删除）", store.deleteValue("v2") && (store.getRawDb().prepare("SELECT state FROM core_values WHERE value_id='v2'").get() as { state: string }).state === "vetoed");
  check("1j 再删 → false（与旧硬删观测形态一致）", store.deleteValue("v2") === false);
  check("1k vetoed 任何读面不可见（默认 + includeRetired）", store.listValues().every((r) => r.value_id !== "v2") && store.listValues(undefined, { includeRetired: true }).every((r) => r.value_id !== "v2"));
  check("1l vetoed 行 pin/retire/restore 全拒绝", !store.setValuePinned("v2", true) && !store.retireValue("v2") && !store.restoreValue("v2"));
  store.upsertValue("v2", "锚二重添", 0.9, "verify");
  check("1m upsert 重添 vetoed → state=active（显式撤销否决）", (store.listValues().find((r) => r.value_id === "v2")?.state === "active"));

  // upsert 冲突不改写 origin/pinned（裁定 3）
  store.upsertValue("v3", "自生长锚", 0.6, "auto-growth", undefined, undefined, "auto");
  store.setValuePinned("v3", true);
  store.upsertValue("v3", "自生长锚 v2", 0.7, "manual");
  const v3 = store.listValues().find((r) => r.value_id === "v3")!;
  check("1n upsert 冲突：state 保持 active、origin/pinned 不被改写", v3.state === "active" && v3.origin === "auto" && v3.pinned === 1, JSON.stringify(v3));

  store.close();
}

// ── 断言组 2：自生长护栏四件（真库 + mock runner）────────────────────

async function testGrowthGuardrails(tmpDir: string): Promise<void> {
  console.log("\n断言组 2 — 自生长：证据门槛 / +2 上限 / 挤出最弱（pinned 豁免）/ veto 永不重提");
  const store = newStore(tmpDir, "growth");
  // 注：同组多次跑 growth 之间重置调度门（固定时钟下 interval 24h 会拦后续轮次）——
  // 每轮显式设 lastDiscoveryAt=48h 前 + lastCorpusCount=当前-1（模拟"到点 + 有新增"）。
  const rearm = (corpusCount: number) =>
    store.setAnchorGrowthState({ lastDiscoveryAt: hoursAgo(48), lastCorpusCount: corpusCount - 1 });

  // 首轮：语料 16 条（甲 6 / 乙 5 / 丙 5，全部 ≥ minEvidence 5），LLM 提 3 个 → 只采纳 2（maxPerPass）
  const n1 = await seedCorpus(store, "甲主题", 6);
  const n2 = await seedCorpus(store, "乙主题", 5);
  const n3 = await seedCorpus(store, "丙主题", 5);
  const total1 = n1 + n2 + n3;
  rearm(total1);
  const r1 = await runAnchorGrowth({
    store: store as never,
    llmRunner: runner(JSON.stringify([{ label: "甲主题" }, { label: "乙主题" }, { label: "丙主题" }])) as never,
    logger: LOG,
    now,
  });
  check("2a 首轮跑通：adopted=2（maxPerPass 护栏）", r1.ran && r1.adopted === 2, JSON.stringify(r1));
  const after1 = store.listValues();
  check("2b 采纳行 origin=auto / created_by=auto-growth / default 桶", after1.filter((r) => r.origin === "auto").length === 2 && after1.every((r) => r.created_by === "auto-growth"), JSON.stringify(after1));
  const st1 = store.getAnchorGrowthState();
  check("2c 状态持久化：lastCorpusCount=16、lastDiscoveryAt=now", st1.lastCorpusCount === total1 && st1.lastDiscoveryAt === NOW.toISOString(), JSON.stringify(st1));

  // 证据门槛：4 条命中不提（minEvidence 5）
  const nw = await seedCorpus(store, "弱主题", 4, "w");
  rearm(total1 + nw);
  const r2 = await runAnchorGrowth({
    store: store as never,
    llmRunner: runner(JSON.stringify([{ label: "弱主题" }])) as never,
    logger: LOG,
    now,
  });
  check("2d 证据 4 < minEvidence 5 → 不采纳", r2.ran && r2.adopted === 0, JSON.stringify(r2));
  // 5 条命中 → 采纳（先补 1 条语料触发"有新增"）
  await store.upsertL1(mkRecord("w-弱主题-9", "第9条 关于弱主题的记忆"));
  rearm(total1 + nw + 1);
  const r3 = await runAnchorGrowth({
    store: store as never,
    llmRunner: runner(JSON.stringify([{ label: "弱主题" }])) as never,
    logger: LOG,
    now,
  });
  check("2e 证据 5 ≥ minEvidence 5 → 采纳", r3.adopted === 1, JSON.stringify(r3));

  // veto 永不重提
  const vetoedBefore = store.listValuesAnyState().find((r) => r.label === "甲主题");
  if (!vetoedBefore) throw new Error("2f 前置失败：甲主题 auto 锚不存在");
  store.deleteValue(vetoedBefore.value_id);
  await store.upsertL1(mkRecord("c-甲主题-x", "新增一条 关于甲主题的记忆"));
  rearm(total1 + nw + 2);
  const r4 = await runAnchorGrowth({
    store: store as never,
    llmRunner: runner(JSON.stringify([{ label: "甲主题" }])) as never,
    logger: LOG,
    now,
  });
  check("2f veto 永不重提（dedup 查全态）", r4.adopted === 0, JSON.stringify(r4));

  store.close();
}

// ── 断言组 3：挤出（名额满，pinned 豁免）────────────────────────────

async function testDisplacement(tmpDir: string): Promise<void> {
  console.log("\n断言组 3 — 挤出：名额满 → 新候选强度 > 最弱自生长锚（pinned 豁免）才替换");
  const store = newStore(tmpDir, "displace");
  await seedCorpus(store, "强候选主题", 8);

  // maxTotal=3：pinned 种子 1 + auto 活跃 2 = 满；弱锚（0.3×0 命中）被挤出
  store.upsertValue("p1", "钉住种子", 0.9, "seed", undefined, undefined, "seed");
  store.setValuePinned("p1", true);
  store.upsertValue("a-strong", "关于强候选主题的记忆", 0.8, "auto-growth", undefined, undefined, "auto");
  store.upsertValue("a-weak", "无从命中的旧主题", 0.3, "auto-growth", undefined, undefined, "auto");
  // 基线：语料已有 8 条 → 先把状态基线设为 7（模拟新增 1 条后触发）
  store.setAnchorGrowthState({ lastDiscoveryAt: hoursAgo(48), lastCorpusCount: 7 });

  const r1 = await runAnchorGrowth({
    store: store as never,
    llmRunner: runner(JSON.stringify([{ label: "强候选主题" }])) as never,
    config: { maxTotal: 3 },
    logger: LOG,
    now,
  });
  check("3a 挤出最弱 auto 锚：displaced=1 + adopted=1", r1.displaced === 1 && r1.adopted === 1, JSON.stringify(r1));
  check("3b 被挤出者 state=retired（可恢复，非硬删）", (store.listValues(undefined, { includeRetired: true }).find((r) => r.value_id === "a-weak")?.state === "retired"));
  check("3c 新锚已入 active 池", store.listValues().some((r) => r.label === "强候选主题" && r.state === "active"));

  // pinned 豁免：全部 auto 锚钉住 → 无挤出目标 → 不采纳
  store.setValuePinned("a-strong", true);
  await store.upsertL1(mkRecord("c-强候选主题-x", "新增一条 关于强候选主题的记忆"));
  const r2 = await runAnchorGrowth({
    store: store as never,
    llmRunner: runner(JSON.stringify([{ label: "强候选主题", rationale: "dup" }])) as never,
    config: { maxTotal: 3 },
    logger: LOG,
    now,
  });
  // "强候选主题" 恰是已 active 锚 "关于强候选主题的记忆" 的子串但非同 label → 去重不拦；
  // 但 pinned 豁免后无挤出目标 → skipped
  check("3d 全 auto 锚 pinned → pinned 豁免不挤出、不采纳", r2.adopted === 0 && r2.displaced === 0, JSON.stringify(r2));

  // 恢复钉住的强锚继续验证强度不足不挤出的守卫路径（不大于 → skipped）
  store.setValuePinned("a-strong", false);
  await store.upsertL1(mkRecord("c-强候选主题-y", "再增一条 关于强候选主题的记忆"));
  const r3 = await runAnchorGrowth({
    store: store as never,
    llmRunner: runner(JSON.stringify([{ label: "强候选主题", rationale: "dup2" }])) as never,
    config: { maxTotal: 3 },
    logger: LOG,
    now,
  });
  check("3e 候选强度 6.4 ≤ 最弱 6.4 → 不挤出不采纳（宁缺毋滥）", r3.adopted === 0 && r3.displaced === 0, JSON.stringify(r3));

  store.close();
}

// ── 断言组 4：调度触发双门（真库 kv 状态）────────────────────────────

async function testScheduleGates(tmpDir: string): Promise<void> {
  console.log("\n断言组 4 — 调度触发：interval 未到不跑 / 语料无新增不跑 / 状态不被消费");
  const store = newStore(tmpDir, "gates");
  await seedCorpus(store, "增量对账", 9);

  // interval 未到（23h < 24h）
  store.setAnchorGrowthState({ lastDiscoveryAt: hoursAgo(23), lastCorpusCount: 8 });
  const llmCalls: number[] = [];
  const countingRunner = { run: async () => { llmCalls.push(1); return "[]"; } };
  const r1 = await runAnchorGrowth({ store: store as never, llmRunner: countingRunner as never, logger: LOG, now });
  check("4a interval 未到 → 不跑（零 LLM 调用）", r1.reason === "interval" && llmCalls.length === 0, JSON.stringify(r1));

  // interval 已到但语料无新增
  store.setAnchorGrowthState({ lastDiscoveryAt: hoursAgo(25), lastCorpusCount: 9 });
  const r2 = await runAnchorGrowth({ store: store as never, llmRunner: countingRunner as never, logger: LOG, now });
  check("4b 语料无新增 → 不跑", r2.reason === "no-new-corpus" && llmCalls.length === 0, JSON.stringify(r2));
  check("4c 未跑轮次不消费 interval（lastDiscoveryAt 保持 25h 前）", store.getAnchorGrowthState().lastDiscoveryAt === hoursAgo(25));

  // 语料新增 → 跑
  await store.upsertL1(mkRecord("c-增量对账-new", "新增一条 关于增量对账的记忆"));
  const r3 = await runAnchorGrowth({ store: store as never, llmRunner: countingRunner as never, logger: LOG, now });
  check("4d interval 到 + 语料新增 → 跑（LLM 调用 1 次）+ 状态推进", r3.ran && llmCalls.length === 1 && store.getAnchorGrowthState().lastDiscoveryAt === NOW.toISOString() && store.getAnchorGrowthState().lastCorpusCount === 10, JSON.stringify({ r3, state: store.getAnchorGrowthState() }));

  store.close();
}

// ── 断言组 5：handler 链路 + include_retired 读面 ────────────────────

async function testHandlerChain(tmpDir: string): Promise<void> {
  console.log("\n断言组 5 — handler：pin/retire/restore 200/404 + read include_retired 出参");
  const store = newStore(tmpDir, "handlers");
  store.upsertValue("candor", "坦率", 0.7, "verify");

  const deps = (iso?: { teamId?: string; userId?: string; agentId?: string }) => ({
    getStore: () => store,
    logger: LOG,
    requestIsolation: { teamId: iso?.teamId, userId: iso?.userId ?? "default", agentId: iso?.agentId ?? "default", sessionId: "s1" },
  }) as never;

  const pinRes = (await handleCoreMemoryValuesPin({ value_id: "candor", pinned: true }, {} as never, "req-g-1", deps())) as { code?: number };
  check("5a pin → 200/code=0", pinRes.code === 0, JSON.stringify(pinRes));
  check("5b pin 落库（pinned=1）", store.listValues()[0]!.pinned === 1);

  const pinBad = (await handleCoreMemoryValuesPin({ value_id: "candor", pinned: "yes" }, {} as never, "req-g-2", deps())) as { code?: number };
  check("5c pinned 非布尔 → 400", pinBad.code === 400, JSON.stringify(pinBad));

  const pinGhost = (await handleCoreMemoryValuesPin({ value_id: "ghost", pinned: true }, {} as never, "req-g-3", deps())) as { code?: number };
  check("5d pin 不存在 → 404 不伪成功（M-1）", pinGhost.code === 404, JSON.stringify(pinGhost));

  const retireRes = (await handleCoreMemoryValuesRetire({ value_id: "candor" }, {} as never, "req-g-4", deps())) as { code?: number };
  check("5e retire → 200；默认读面消失", retireRes.code === 0 && store.listValues().length === 0, JSON.stringify(retireRes));

  const readDefault = (await handleCoreMemoryRead({}, {} as never, "req-g-5", deps())) as { data?: { values?: unknown[] } };
  const readRetired = (await handleCoreMemoryRead({ include_retired: true }, {} as never, "req-g-6", deps())) as { data?: { values?: Array<Record<string, unknown>> } };
  check("5f 默认 read 不回 retired；include_retired=true 回（带 origin/pinned/state）",
    (readDefault.data?.values ?? []).length === 0 &&
    readRetired.data?.values?.length === 1 &&
    "origin" in readRetired.data!.values![0]! && "pinned" in readRetired.data!.values![0]! && "state" in readRetired.data!.values![0]!,
    JSON.stringify(readRetired.data?.values));

  const restoreRes = (await handleCoreMemoryValuesRestore({ value_id: "candor" }, {} as never, "req-g-7", deps())) as { code?: number };
  check("5g restore → 200；回 active 读面", restoreRes.code === 0 && store.listValues().length === 1);

  const restoreGhost = (await handleCoreMemoryValuesRestore({ value_id: "candor" }, {} as never, "req-g-8", deps())) as { code?: number };
  check("5h active 行 restore → 404（0 行变更）", restoreGhost.code === 404, JSON.stringify(restoreGhost));

  store.close();
}

// ── main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=== Task GROW 同形验证 ===");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-grow-"));
  let hardFail = false;
  try {
    const groups: Array<[string, (d: string) => Promise<void>]> = [
      ["state-machine", testStateMachine],
      ["growth-guardrails", testGrowthGuardrails],
      ["displacement", testDisplacement],
      ["schedule-gates", testScheduleGates],
      ["handler-chain", testHandlerChain],
    ];
    for (const [name, fn] of groups) {
      try {
        await fn(tmpDir);
      } catch (err) {
        hardFail = true;
        console.error(`verify script crashed in group "${name}":`, err instanceof Error ? err.message : err);
      }
    }
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Windows 句柄释放时序问题：清理失败不影响断言（临时目录留在系统 TEMP 下，无害）
    }
  }
  console.log(`\n=== 结果：${pass} passed, ${fail} failed ===`);
  if (fail > 0 || hardFail) process.exit(1);
}

main().catch((err) => {
  console.error("verify script crashed:", err);
  process.exit(1);
});
