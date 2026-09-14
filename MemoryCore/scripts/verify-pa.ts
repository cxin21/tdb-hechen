/**
 * Task PA 同形验证：价值锚 per-agent 严格独立（推翻 spec §5.1 裁决 2）。
 *
 * 断言组（task-pa-brief §6 验收契约）：
 *   1. 严格无兜底 + default 锚扇出迁移（幂等）：有记忆 agent 桶得扇出副本
 *      （origin='seed'、pinned/valence/state 沿用）、无记忆 agent 不扇出、二次 init 零重复、
 *      空桶 agent listValues = []（default 锚不再读时回退）。
 *   2. 四场景 × 双 agent 独立性（A/B 各自有记忆与锚）：
 *      ① 自生长：A 长锚不影响 B 的桶；A 的发现采样不含 B 的记忆；
 *      ② 挤出：A 挤出最弱锚 → A 的绑定惰性（valueBoost 不再命中该 label）/
 *         B 的同名锚与记忆不受影响；
 *      ③ 删除（veto）：A veto 后不重提不可见 / B 的同名锚照常；
 *      ④ 恢复：A 恢复 retired → A 的记忆绑定复活（valueBoost 重新命中）。
 *   3. per-agent 双门：interval / 语料基线按 agent 独立；无记忆 agent 不消耗 LLM。
 *
 * 用法（在 MemoryCore 目录下）：
 *   node --import tsx scripts/verify-pa.ts
 *
 * 只用自建临时库，不连任何线上资源、不碰生产数据目录（D:/tdai-data/ 不触碰）；
 * 跑完自动清理临时目录。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { VectorStore } from "../src/core/store/sqlite.js";
import { runAnchorGrowth } from "../src/core/lifecycle/anchor-growth.js";
import { salienceBoostWithRefs, type CoreValue } from "../src/core/lifecycle/feeling/appraisal.js";
import type { MemoryRecord } from "../src/core/record/l1-writer.js";
import type { CoreTenant } from "../src/core/store/types.js";

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

const T_A: CoreTenant = { teamId: "teamA", userId: "userA", agentId: "agentA" };
const T_B: CoreTenant = { teamId: "teamB", userId: "userB", agentId: "agentB" };
const T_C: CoreTenant = { teamId: "teamC", userId: "userC", agentId: "agentC" };
const T_D: CoreTenant = { teamId: "teamD", userId: "userD", agentId: "agentD" };

function mkRecord(id: string, content: string, tenant: CoreTenant): MemoryRecord {
  return {
    id,
    content,
    type: "episodic",
    priority: 0,
    scene_name: "s",
    source_message_ids: [],
    metadata: {},
    timestamps: ["2026-09-01T00:00:00Z"],
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    version: 0,
    sessionKey: "k",
    sessionId: "s",
    teamId: tenant.teamId,
    userId: tenant.userId,
    agentId: tenant.agentId,
  } as MemoryRecord;
}

function newStore(dir: string, name: string): VectorStore {
  const store = new VectorStore(path.join(dir, `${name}.db`), 0);
  const res = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级（环境问题，非行为断言）：${JSON.stringify(res)}`);
  return store;
}

function rearm(store: VectorStore, tenant: CoreTenant, corpusCount: number): void {
  store.setAnchorGrowthState({ lastDiscoveryAt: hoursAgo(48), lastCorpusCount: corpusCount - 1 }, tenant);
}

function boost(memoryCoreRefs: string[], rows: Array<{ label: string; weight: number }>): number {
  const values: CoreValue[] = rows.map((r) => ({ id: r.label, label: r.label, weight: r.weight }));
  return salienceBoostWithRefs({ content: "", metadata: { coreRefs: memoryCoreRefs } }, values);
}

// ── 断言组 1：严格无兜底 + default 锚扇出迁移（幂等）────────────────────

async function testStrictAndFanout(tmpDir: string): Promise<void> {
  console.log("\n断言组 1 — 严格无兜底 + default 锚扇出迁移（幂等，SEC-1 模式）");
  const dbPath = path.join(tmpDir, "fanout.db");

  // 存量形态：default 桶 3 锚（pinned+valence / 普通 / retired）+ A/B/default 有记忆 + C 有锚无记忆
  const seed = new VectorStore(dbPath, 0);
  let res = seed.init();
  if (seed.isDegraded()) throw new Error(`临时库初始化降级（环境问题，非行为断言）：${JSON.stringify(res)}`);
  seed.upsertValue("honesty", "诚实", 0.9, "seed", undefined, 1, "seed");
  seed.setValuePinned("honesty", true);
  seed.upsertValue("candor", "坦率", 0.7, "manual", undefined, -1);
  seed.upsertValue("retired-one", "退休锚", 0.5, "manual");
  seed.retireValue("retired-one");
  seed.upsertL1(mkRecord("a1", "A 的记忆", T_A), undefined);
  seed.upsertL1(mkRecord("a2", "A 的记忆 2", T_A), undefined);
  seed.upsertL1(mkRecord("b1", "B 的记忆", T_B), undefined);
  seed.upsertL1(mkRecord("d1", "default 的记忆", { teamId: "default", userId: "default", agentId: "default" }), undefined);
  seed.upsertValue("honesty", "C 自己的诚实", 0.4, "manual", T_C);
  seed.close();

  // 重新打开 = 二次 init → 扇出迁移执行
  const store = new VectorStore(dbPath, 0);
  res = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级：${JSON.stringify(res)}`);

  const a = store.listValuesAnyState(T_A);
  check("1a A 桶扇出 3 锚（origin='seed'、pinned/valence/weight/state 沿用）",
    a.length === 3 &&
    a.find((v) => v.value_id === "honesty")?.origin === "seed" &&
    a.find((v) => v.value_id === "honesty")?.pinned === 1 &&
    a.find((v) => v.value_id === "honesty")?.valence === 1 &&
    a.find((v) => v.value_id === "candor")?.valence === -1 &&
    a.find((v) => v.value_id === "retired-one")?.state === "retired",
    JSON.stringify(a));
  check("1b B 桶扇出 3 锚", store.listValuesAnyState(T_B).length === 3, JSON.stringify(store.listValuesAnyState(T_B)));
  const d = store.listValuesAnyState();
  check("1c default 桶原样（origin 不被改写）", d.length === 3 && d.find((v) => v.value_id === "candor")?.origin === "manual", JSON.stringify(d));
  const c = store.listValuesAnyState(T_C);
  check("1d 无记忆 agent 不扇出 + 已有自己锚不被改写", c.length === 1 && c[0]!.label === "C 自己的诚实" && c[0]!.weight === 0.4, JSON.stringify(c));
  check("1e 严格无兜底：无记忆无锚 agent → listValues=[]（default 有锚也不回退）", store.listValues(T_D).length === 0, JSON.stringify(store.listValues(T_D)));
  // 运行期严格性：init 扇出完成后，新写入记忆的 agent（E）在下次 init 前无锚 → 严格空
  store.upsertL1(mkRecord("e1", "E 的记忆", T_D), undefined);
  check("1f 严格无兜底：运行期新增记忆 agent 无锚 → listValues=[]", store.listValues(T_D).length === 0, JSON.stringify(store.listValues(T_D)));

  // 幂等：三次 init 零重复
  store.close();
  const store2 = new VectorStore(dbPath, 0);
  store2.init();
  store2.close();
  const store3 = new VectorStore(dbPath, 0);
  store3.init();
  const count = (store3.getRawDb().prepare("SELECT COUNT(*) AS n FROM core_values").get() as { n: number }).n;
  // default 3 + A 3 + B 3 + C 1 + D 3（1f 给 D 补了记忆 → 二次 init 扇出追平，预期）= 13；
  // 三次 init 之间零新增（INSERT OR IGNORE 幂等；无记忆 agent 不扇出）。
  check("1g 二次 init 幂等零重复（行数恒 13，无记忆 agent 不扇出）", count === 13, `rows=${count}`);
  store3.close();
}

// ── 断言组 2：四场景 × 双 agent 独立性（真库 + mock runner）──────────────

async function testFourScenarios(tmpDir: string): Promise<void> {
  console.log("\n断言组 2 — 四场景 × 双 agent：自生长/挤出/veto/恢复 全 per-agent 隔离");
  const store = newStore(tmpDir, "scenarios");

  // 语料：A = A主题×5 + 新主题×5；B = B主题×5（互不重叠，防跨 agent 蒸馏）
  for (let i = 0; i < 5; i++) {
    store.upsertL1(mkRecord(`a-A主题-${i}`, `第${i}条 关于A主题的记忆`, T_A), undefined);
    store.upsertL1(mkRecord(`a-新主题-${i}`, `第${i}条 关于新主题的记忆`, T_A), undefined);
    store.upsertL1(mkRecord(`b-B主题-${i}`, `第${i}条 关于B主题的记忆`, T_B), undefined);
  }
  // 同名锚两侧各一份（挤出/veto/恢复的隔离探针）
  store.upsertValue("weak", "脆弱主题", 0.6, "manual", T_A, undefined, "auto");
  store.upsertValue("weak-b", "脆弱主题", 0.6, "manual", T_B, undefined, "auto");
  store.upsertValue("common", "共同主题", 0.6, "manual", T_A);
  store.upsertValue("common-b", "共同主题", 0.6, "manual", T_B);
  store.upsertValue("revive", "复活主题", 0.6, "manual", T_A);
  store.upsertValue("revive-b", "复活主题", 0.6, "manual", T_B);
  // A 桶名额构造（场景 ②）：pinned 种子 + auto A主题 + auto 强主题 + auto 脆弱主题(弱,零命中)
  store.upsertValue("p1", "钉住种子", 0.9, "seed", T_A, undefined, "seed");
  store.setValuePinned("p1", true, T_A);
  store.upsertValue("a-auto1", "A主题", 0.7, "auto-growth", T_A, undefined, "auto");
  store.upsertValue("a-strong", "强主题", 0.8, "auto-growth", T_A, undefined, "auto");
  // B 桶同款 pinned 种子（B 的钉住是 B 的事，与 A 无关）
  store.upsertValue("p1-b", "钉住种子", 0.9, "seed", T_B, undefined, "seed");
  store.setValuePinned("p1-b", true, T_B);

  const prompts: string[] = [];
  const runner = {
    run: async (params: { prompt: string }) => {
      prompts.push(params.prompt);
      // 注意顺序：A 的语料同时含新主题/挤压主题，② 期只提挤压主题（避免与①已采纳锚去重相撞）
      if (params.prompt.includes("挤压主题")) return JSON.stringify([{ label: "挤压主题", rationale: "r" }]);
      if (params.prompt.includes("新主题")) return JSON.stringify([{ label: "新主题", rationale: "r" }]);
      if (params.prompt.includes("B主题")) return JSON.stringify([{ label: "B主题", rationale: "r" }]);
      return "[]";
    },
  };

  // ══ 场景 ①：自生长隔离 ═══════════════════════════════════════════
  console.log("  —— 场景 ①：自生长 per-agent 隔离 ——");
  rearm(store, T_A, 10);
  rearm(store, T_B, 5);
  const r1 = await runAnchorGrowth({ store: store as never, llmRunner: runner as never, logger: LOG, now });
  check("①-1 A、B 两 agent 各跑一轮发现（LLM=agent 数次）", r1.ran && prompts.length === 2, JSON.stringify({ r1, prompts: prompts.length }));
  check("①-2 A 的发现采样只含 A 的语料、不含 B 的记忆（防跨 agent 蒸馏）",
    prompts[0]!.includes("A主题") && !prompts[0]!.includes("B主题") &&
    prompts[1]!.includes("B主题") && !prompts[1]!.includes("A主题"),
    prompts.map((p) => p.slice(0, 60)).join(" | "));
  check("①-3 A 长出新锚落 A 桶（origin=auto）", store.listValues(T_A).some((v) => v.label === "新主题" && v.origin === "auto"), JSON.stringify(store.listValues(T_A)));
  check("①-4 B 的桶不受 A 生长影响（无 A 的锚）", !store.listValues(T_B).some((v) => v.label === "新主题") && store.listValues(T_B).some((v) => v.label === "B主题"), JSON.stringify(store.listValues(T_B)));
  check("①-5 状态 per-agent 持久化（A/B 基线独立）",
    store.getAnchorGrowthState(T_A).lastCorpusCount === 10 && store.getAnchorGrowthState(T_B).lastCorpusCount === 5,
    JSON.stringify([store.getAnchorGrowthState(T_A), store.getAnchorGrowthState(T_B)]));

  // ══ 场景 ②：挤出 → 绑定惰性 / B 不受影响 ═════════════════════════
  console.log("  —— 场景 ②：A 挤出最弱锚 → A 绑定惰性、B 同名锚照常 ——");
  // 挤出前：A、B 的"脆弱主题"都 active，各自记忆绑定都命中
  check("②-0 前置：挤出前 A/B 绑定都命中（valueBoost>0）",
    boost(["脆弱主题"], store.listValues(T_A)) > 0 && boost(["脆弱主题"], store.listValues(T_B)) > 0);
  // A 补 5 条"挤压主题"语料（新候选，避免与①已采纳的新主题去重相撞）
  for (let i = 0; i < 5; i++) {
    store.upsertL1(mkRecord(`a-挤压主题-${i}`, `第${i}条 关于挤压主题的记忆`, T_A), undefined);
  }
  rearm(store, T_A, 15);
  rearm(store, T_B, 5);
  const r2 = await runAnchorGrowth({ store: store as never, llmRunner: runner as never, config: { maxTotal: 3 }, logger: LOG, now });
  check("②-1 A 桶名额满（pinned 1 + auto 3 > maxTotal 3）→ 挤出最弱自生长锚（脆弱主题，weight×0 命中）", r2.displaced === 1 && r2.adopted === 1, JSON.stringify(r2));
  const aWeak = store.listValues(T_A, { includeRetired: true }).find((v) => v.label === "脆弱主题");
  check("②-2 A 的脆弱主题被挤出（state=retired，active 读面消失）", aWeak?.state === "retired" && !store.listValues(T_A).some((v) => v.label === "脆弱主题"), JSON.stringify(aWeak));
  check("②-3 A 的绑定惰性：valueBoost 不再命中该 label", boost(["脆弱主题"], store.listValues(T_A)) === 0, `boost=${boost(["脆弱主题"], store.listValues(T_A))}`);
  const bWeak = store.listValues(T_B).find((v) => v.label === "脆弱主题");
  check("②-4 B 的同名锚不受影响（仍 active）", bWeak?.state === "active", JSON.stringify(bWeak));
  check("②-5 B 的记忆绑定照常命中", boost(["脆弱主题"], store.listValues(T_B)) > 0, `boost=${boost(["脆弱主题"], store.listValues(T_B))}`);

  // ══ 场景 ③：删除（veto）per-agent ════════════════════════════════
  console.log("  —— 场景 ③：A veto 共同主题 → 仅 A 桶否决、B 照常 ——");
  check("③-0 前置：veto 前 A/B 都可见共同主题", store.listValues(T_A).some((v) => v.label === "共同主题") && store.listValues(T_B).some((v) => v.label === "共同主题"));
  check("③-1 A veto → true", store.deleteValue("common", T_A));
  check("③-2 A 读面不可见（active 与 includeRetired 都不含 vetoed）",
    !store.listValues(T_A).some((v) => v.label === "共同主题") && !store.listValues(T_A, { includeRetired: true }).some((v) => v.label === "共同主题"));
  check("③-3 B 的同名锚照常（active）", store.listValues(T_B).some((v) => v.label === "共同主题" && v.state === "active"), JSON.stringify(store.listValues(T_B)));
  // veto 永不重提是 per-agent 的：B 的全态清单拦 B，A 的拦 A（A 的提案不再提共同主题）
  rearm(store, T_A, 10);
  rearm(store, T_B, 5);
  const vetoRunner = {
    run: async (params: { prompt: string }) => JSON.stringify([{ label: "共同主题", rationale: "r" }]),
  };
  const r3 = await runAnchorGrowth({ store: store as never, llmRunner: vetoRunner as never, config: { maxTotal: 15 }, logger: LOG, now });
  check("③-4 veto 永不重提（per-agent 全态去重）：A 桶不复活、B 桶已有同名锚也不重复采纳", r3.adopted === 0, JSON.stringify({ r3, a: store.listValues(T_A).filter((v) => v.label === "共同主题").length }));

  // ══ 场景 ④：恢复 → 绑定复活 ═════════════════════════════════════
  console.log("  —— 场景 ④：A 恢复 retired 锚 → A 的记忆绑定复活 ——");
  check("④-0 前置：A 退休复活主题（B 照常 active）", store.retireValue("revive", T_A) &&
    !store.listValues(T_A).some((v) => v.label === "复活主题") &&
    store.listValues(T_B).some((v) => v.label === "复活主题"));
  check("④-1 退休期间 A 绑定惰性（valueBoost=0）、B 照常命中",
    boost(["复活主题"], store.listValues(T_A)) === 0 && boost(["复活主题"], store.listValues(T_B)) > 0);
  check("④-2 A restore → true + 回 active 读面", store.restoreValue("revive", T_A) && store.listValues(T_A).some((v) => v.label === "复活主题" && v.state === "active"));
  check("④-3 A 的记忆绑定复活（valueBoost 重新命中，coreRefs 零清理）", boost(["复活主题"], store.listValues(T_A)) > 0, `boost=${boost(["复活主题"], store.listValues(T_A))}`);

  store.close();
}

// ── 断言组 3：per-agent 双门 + 无记忆 agent 不消耗 LLM ──────────────────

async function testPerAgentGates(tmpDir: string): Promise<void> {
  console.log("\n断言组 3 — per-agent 双门：interval/语料基线按 agent 独立；无记忆 agent 零 LLM");
  const store = newStore(tmpDir, "gates");
  for (let i = 0; i < 3; i++) {
    store.upsertL1(mkRecord(`a-A主题-${i}`, `第${i}条 关于A主题的记忆`, T_A), undefined);
    store.upsertL1(mkRecord(`b-B主题-${i}`, `第${i}条 关于B主题的记忆`, T_B), undefined);
  }
  const triplets = store.listL1TenantTriplets();
  check("3-前置. 三元组枚举 = 有记忆 agent（C/D 等无记忆 agent 不在列）",
    triplets.length === 2 && triplets.some((t) => t.agentId === "agentA") && triplets.some((t) => t.agentId === "agentB"),
    JSON.stringify(triplets));

  let llmCalls = 0;
  const countingRunner = { run: async () => { llmCalls++; return "[]"; } };

  // A 到点、B 刚跑过（1h 前）→ 只跑 A
  store.setAnchorGrowthState({ lastDiscoveryAt: hoursAgo(48), lastCorpusCount: 2 }, T_A);
  store.setAnchorGrowthState({ lastDiscoveryAt: hoursAgo(1), lastCorpusCount: 3 }, T_B);
  const r1 = await runAnchorGrowth({ store: store as never, llmRunner: countingRunner as never, logger: LOG, now });
  check("3a interval per-agent：A 到点 B 未到 → 只跑 A（LLM 1 次）", r1.ran && llmCalls === 1, JSON.stringify({ r1, llmCalls }));
  check("3b A 状态推进、B 状态不被消费（仍 1h 前）",
    store.getAnchorGrowthState(T_A).lastDiscoveryAt === NOW.toISOString() &&
    store.getAnchorGrowthState(T_B).lastDiscoveryAt === hoursAgo(1),
    JSON.stringify([store.getAnchorGrowthState(T_A), store.getAnchorGrowthState(T_B)]));

  // A 无新增（count ≤ 基线）、B 有新增 → 只跑 B
  store.setAnchorGrowthState({ lastDiscoveryAt: hoursAgo(48), lastCorpusCount: 3 }, T_A);
  store.setAnchorGrowthState({ lastDiscoveryAt: hoursAgo(48), lastCorpusCount: 2 }, T_B);
  llmCalls = 0;
  const r2 = await runAnchorGrowth({ store: store as never, llmRunner: countingRunner as never, logger: LOG, now });
  check("3c 语料基线 per-agent：A 无新增 B 有新增 → 只跑 B（LLM 1 次）", r2.ran && llmCalls === 1, JSON.stringify({ r2, llmCalls }));

  // 全部未到点 → 整轮不跑
  store.setAnchorGrowthState({ lastDiscoveryAt: hoursAgo(1), lastCorpusCount: 3 }, T_A);
  store.setAnchorGrowthState({ lastDiscoveryAt: hoursAgo(2), lastCorpusCount: 3 }, T_B);
  llmCalls = 0;
  const r3 = await runAnchorGrowth({ store: store as never, llmRunner: countingRunner as never, logger: LOG, now });
  check("3d 双 agent 都未到点 → 不跑（零 LLM，ran=false）", !r3.ran && llmCalls === 0, JSON.stringify({ r3, llmCalls }));

  store.close();
}

// ── main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=== Task PA 同形验证（价值锚 per-agent 严格独立）===");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-pa-"));
  let hardFail = false;
  try {
    const groups: Array<[string, (d: string) => Promise<void>]> = [
      ["strict-and-fanout", testStrictAndFanout],
      ["four-scenarios", testFourScenarios],
      ["per-agent-gates", testPerAgentGates],
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
