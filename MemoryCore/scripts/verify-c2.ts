/**
 * C2 同形验证：动机方向（valence 列 + LLM 总结初值 + 用户微调 + 三态渲染）。
 *
 * 背景（spec §3 v2 / plan Task C2）：
 *   core_values 加 valence REAL（可空，NULL=未判定）：+1=趋近推进、-1=审慎回避、0=中性。
 *   三方语义（优先级从高到低）：
 *     1. 用户微调：values/upsert 增可选 valence（clamp 三值）——显式微调永远优先，
 *        fire-and-forget LLM 钩子永不覆盖非 NULL 值；
 *     2. LLM 总结初值：deriveValueValences 只对 valence IS NULL 的行批量判定
 *        （三值枚举，不确定给 0），解析失败/幻觉 value_id/非法枚举 → 保持 NULL（R3 降级可见）；
 *     3. 重判入口：POST /values/derive = 先重置（全租户 valence→NULL，用户显式动作）
 *        再 LLM 判 NULL 行 —— 微调错了想重置的闭环。
 *   渲染（MemoryProxy renderCurrentFeeling）：仅 fired 且 valence 非 NULL 非 0 才出方向行；
 *   混合两行并列；全 0/NULL/未命中不输出（宁缺毋滥）。
 *
 * 断言组（验收契约，同形：真实临时库 + mock LLMRunner + 真实 handler + 真实渲染函数）：
 *   1. valence 列存在且 NULL 起步；幂等 ALTER（二次 init 不抛）
 *   2. RED-1：新建 value 无 valence → 渲染无方向行 → LLM 判定后 valence=1 → 渲染出方向行；
 *      再 derive（无 NULL 行）→ {derived:0}，LLM 调用次数不增（只判 NULL，不被再判）
 *   3. RED-2：derive 路由重置+重判（微调 -1 → derive(reset) → LLM 结果覆盖）
 *   4. RED-3：upsert 微调覆盖 LLM 且不被 fire-and-forget 再判（只判 NULL）
 *   5. LLM 降级面：垃圾输出/幻觉 value_id/非法枚举 → 保持 NULL（R3）
 *   6. handler 降级面：无 runner → 503；store 不支持 → 503；derive 路由 code=0 返回 {derived,skipped}
 *   7. upsert valence clamp 三值 + 非法 valence → 400
 *   8. 租户隔离：A 租户 derive 只动 A 的 NULL 行
 *   9. 渲染三态全链：正/负/混合/0/NULL/未命中
 *   10. Critical-1 并发守卫：LLM 判定窗口（run 未 resolve）内用户微调（upsert 带 valence）
 *       落库的值不被 LLM 判定覆盖；其余 NULL 行正常判定；derived=真实 changes 数
 *   11. Important-1 apply-after-success：reset+LLM 失败/垃圾输出 → 微调值从快照恢复；
 *       reset+LLM 成功 → 新值生效；部分成功 → 有效行应用 + 无效行恢复
 *
 * 用法（在 MemoryCore 目录下）：
 *   node --import tsx scripts/verify-c2.ts
 *
 * 纯本地验证（临时库 + mock LLM），不连任何线上资源、不碰生产数据目录。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { VectorStore } from "../src/core/store/sqlite.js";
import { handleCoreMemoryValuesUpsert, handleCoreMemoryValuesDerive } from "../src/gateway/v2-router.js";
import type { LLMRunner } from "../src/types.js";
import type { CoreTenant } from "../src/core/store/types.js";
// C2 渲染函数在 MemoryProxy（T16 每轮注入器消费的同一体）——跨包直引源码（纯函数、零依赖）。
import { renderCurrentFeeling } from "../../MemoryProxy/src/knowledge/current-feeling.js";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── harness（与 verify-s1 同源）────────────────────────────────────

async function withTempStore(
  label: string,
  fn: (store: VectorStore, tmpDir: string) => Promise<void>,
): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `verify-c2-${label}-`));
  const dbPath = path.join(tmpDir, "vectors.db");
  const store = new VectorStore(dbPath, 64, console as never);
  await store.init();
  try {
    if (store.isDegraded?.()) {
      check(`[${label}] 前置`, false, "临时库初始化降级（环境问题，非行为断言）");
      return;
    }
    await fn(store, tmpDir);
    // 幂等 ALTER：同一 db 文件二次 init 不抛、不损数据（迁移幂等契约）
    const store2 = new VectorStore(dbPath, 64, console as never);
    await store2.init();
    store2.close();
  } finally {
    try { store.close(); } catch { /* Windows 句柄时序 */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows 句柄时序 */ }
  }
}

const TENANT_A: CoreTenant = { teamId: "teamA", userId: "userA", agentId: "agentA" };
const TENANT_B: CoreTenant = { teamId: "teamB", userId: "userB", agentId: "agentB" };
const ISO_A = { teamId: "teamA", userId: "userA", agentId: "agentA", sessionId: "s1" };
const ISO_B = { teamId: "teamB", userId: "userB", agentId: "agentB", sessionId: "s2" };
const AUTH = {} as never;

interface ValsDeps { llm?: LLMRunner }
function depsFor(store: unknown, iso: typeof ISO_A | typeof ISO_B | undefined, extra: ValsDeps = {}): Parameters<typeof handleCoreMemoryValuesUpsert>[3] {
  return {
    getStore: () => store,
    logger: console as never,
    requestIsolation: iso,
    getValueValenceLlmRunner: () => extra.llm,
  } as never;
}

/** 计数 mock LLM：可编程返回判定 JSON（valences 数组）。 */
function mockValenceLlm(reply: string | (() => string)): LLMRunner & { calls: () => number } {
  let n = 0;
  return {
    run: async () => { n++; return typeof reply === "function" ? reply() : reply; },
    calls: () => n,
  } as never;
}

function valenceOf(store: VectorStore, tenant: CoreTenant, valueId: string): number | null | undefined {
  return store.listValues(tenant).find((v) => v.value_id === valueId)?.valence;
}

/** renderCurrentFeeling 的 values 形状（与 MemoryProxy loadAppraisalValues 输出同构）。 */
function renderVals(store: VectorStore, tenant: CoreTenant): Array<{ id: string; label: string; weight: number; valence?: number | null }> {
  return store.listValues(tenant).map((v) => ({ id: v.value_id, label: v.label, weight: v.weight, valence: v.valence }));
}

console.log("=".repeat(72));
console.log("C2 同形验证：valence 列 / LLM 总结初值 / 用户微调 / derive 重判 / 三态渲染");
console.log("=".repeat(72));

// ── 断言组 1：valence 列存在且 NULL 起步；幂等 ALTER ────────────────
console.log("\n[1] valence 列：新库 NULL 起步 + 二次 init 幂等（withTempStore 内建二次 init）");
{
  await withTempStore("g1", async (store) => {
    store.upsertValue("correct", "正确", 0.9, "verify", TENANT_A);
    const v = valenceOf(store, TENANT_A, "correct");
    check("1a 新写 value 的 valence 为 NULL（未判定）", v === null, `got=${String(v)}`);
    check("1b listValues 返回携带 valence 字段", store.listValues(TENANT_A)[0] !== undefined && "valence" in store.listValues(TENANT_A)[0]);
  });
  check("1c 二次 init 幂等（withTempStore 未抛即通过）", true);
}

// ── 断言组 2：RED-1 新 value → 渲染无方向行 → LLM 判定 → 方向行出现 ──
console.log("\n[2] RED-1：LLM 总结初值全链（渲染跟随 valence 变化）");
{
  await withTempStore("g2", async (store) => {
    // 2a 不传 llm：避免 fire-and-forget 钩子与 2d 显式 derive 并发判定同一 NULL 行
    // （Critical-1 守卫下后到者正确 no-op，会使 2d 的 derived 计数非确定）。
    // fire-and-forget 行为由断言组 4 专门覆盖。
    const res = await handleCoreMemoryValuesUpsert(
      { value_id: "correct", label: "正确", weight: 0.9 },
      AUTH, "req-c2-2a", depsFor(store, ISO_A),
    );
    check("2a upsert handler 成功", res.code === 0, JSON.stringify(res));
    check("2b 判定前 valence=NULL", valenceOf(store, TENANT_A, "correct") === null);
    const before = renderCurrentFeeling("怎么保证正确", {
      enabled: true, firedThreshold: 0.4, values: renderVals(store, TENANT_A),
    });
    check("2c 判定前渲染无方向行（NULL 不输出，宁缺毋滥）", before.includes("正确(correct)") && !before.includes("本轮方向"), JSON.stringify(before));

    const llm = mockValenceLlm('{"valences":[{"value_id":"correct","valence":1}]}');
    const d = await store.deriveValueValences(TENANT_A, llm);
    check("2d derive 判定 1 行", d.derived === 1 && d.skipped === 0, JSON.stringify(d));
    check("2e valence 写回 1", valenceOf(store, TENANT_A, "correct") === 1, `got=${String(valenceOf(store, TENANT_A, "correct"))}`);
    const after = renderCurrentFeeling("怎么保证正确", {
      enabled: true, firedThreshold: 0.4, values: renderVals(store, TENANT_A),
    });
    check("2f 判定后渲染出方向行：本轮方向：围绕【正确】推进", after.includes("本轮方向：围绕【正确】推进"), JSON.stringify(after));

    const d2 = await store.deriveValueValences(TENANT_A, llm);
    check("2g 再 derive：无 NULL → derived=0 且 LLM 不再被调用（只判 NULL）",
      d2.derived === 0 && d2.skipped === 0 && llm.calls() === 1, `calls=${llm.calls()} d2=${JSON.stringify(d2)}`);
  });
}

// ── 断言组 3：RED-2 derive 路由重置+重判 ───────────────────────────
console.log("\n[3] RED-2：/values/derive = 重置（全租户→NULL）+ 重判（用户显式动作）");
{
  await withTempStore("g3", async (store) => {
    // 前置：微调成 -1
    await handleCoreMemoryValuesUpsert(
      { value_id: "risk", label: "风险", weight: 0.8, valence: -1 },
      AUTH, "req-c2-3a", depsFor(store, ISO_A),
    );
    check("3a 前置：微调 valence=-1 落库", valenceOf(store, TENANT_A, "risk") === -1);
    // hook 形态 derive（无 reset）：不覆盖非 NULL
    const llmSilent = mockValenceLlm('{"valences":[{"value_id":"risk","valence":1}]}');
    await store.deriveValueValences(TENANT_A, llmSilent);
    check("3b 无 reset 的 derive 永不覆盖微调值（LLM 永不覆盖非 NULL）",
      valenceOf(store, TENANT_A, "risk") === -1 && llmSilent.calls() === 0, `valence=${String(valenceOf(store, TENANT_A, "risk"))}`);
    // handler derive（reset 语义）：重置 → LLM 重判覆盖
    const llmJudge = mockValenceLlm('{"valences":[{"value_id":"risk","valence":1}]}');
    const d = await handleCoreMemoryValuesDerive({}, AUTH, "req-c2-3c", depsFor(store, ISO_A, { llm: llmJudge }));
    check("3c derive handler code=0 且返回 {derived,skipped}", d.code === 0 && typeof (d.data as { derived?: number })?.derived === "number", JSON.stringify(d));
    check("3d 重判后 LLM 结果覆盖旧微调值（valence=1）", valenceOf(store, TENANT_A, "risk") === 1, `got=${String(valenceOf(store, TENANT_A, "risk"))}`);
  });
}

// ── 断言组 4：RED-3 微调覆盖 LLM 且不被 fire-and-forget 再判 ─────────
console.log("\n[4] RED-3：upsert 微调覆盖 LLM；plain upsert 后的 fire-and-forget 不碰非 NULL");
{
  await withTempStore("g4", async (store) => {
    // 先 LLM 判成 1
    const llmJudge = mockValenceLlm('{"valences":[{"value_id":"correct","valence":1}]}');
    await handleCoreMemoryValuesUpsert({ value_id: "correct", label: "正确", weight: 0.9 }, AUTH, "req-c2-4a", depsFor(store, ISO_A, { llm: llmJudge }));
    await new Promise((r) => setTimeout(r, 80)); // fire-and-forget 落定
    check("4a 前置：LLM 判定 valence=1", valenceOf(store, TENANT_A, "correct") === 1);
    // 用户微调成 -1
    await handleCoreMemoryValuesUpsert({ value_id: "correct", label: "正确", weight: 0.9, valence: -1 }, AUTH, "req-c2-4b", depsFor(store, ISO_A));
    check("4b 微调覆盖 LLM：valence=-1", valenceOf(store, TENANT_A, "correct") === -1);
    // plain upsert（无 valence，更新 label）→ handler fire-and-forget derive（只判 NULL，mock 输出 1 若被误判）
    const llmPoison = mockValenceLlm('{"valences":[{"value_id":"correct","valence":1}]}');
    await handleCoreMemoryValuesUpsert({ value_id: "correct", label: "正确 v2", weight: 0.9 }, AUTH, "req-c2-4c", depsFor(store, ISO_A, { llm: llmPoison }));
    await new Promise((r) => setTimeout(r, 120));
    check("4c fire-and-forget 后微调值不被覆盖（仍 -1）", valenceOf(store, TENANT_A, "correct") === -1, `got=${String(valenceOf(store, TENANT_A, "correct"))}`);
    check("4d label 更新生效（upsert 语义不变）", store.listValues(TENANT_A)[0]?.label === "正确 v2");
  });
}

// ── 断言组 5：LLM 降级面（R3：解析失败保持 NULL）────────────────────
console.log("\n[5] LLM 降级面：垃圾/幻觉/非法枚举 → 保持 NULL");
{
  await withTempStore("g5", async (store) => {
    store.upsertValue("correct", "正确", 0.9, "verify", TENANT_A);
    store.upsertValue("reliable", "可靠", 0.8, "verify", TENANT_A);
    store.upsertValue("risk", "风险", 0.7, "verify", TENANT_A);

    const llmGarbage = mockValenceLlm("这不是 JSON");
    const d1 = await store.deriveValueValences(TENANT_A, llmGarbage);
    check("5a 垃圾输出 → derived=0 skipped=全部（R3）", d1.derived === 0 && d1.skipped === 3, JSON.stringify(d1));
    check("5b 垃圾输出后 valence 保持 NULL", valenceOf(store, TENANT_A, "correct") === null);

    const llmH = mockValenceLlm('{"valences":[{"value_id":"ghost-id","valence":1},{"value_id":"correct","valence":-1}]}');
    const d2 = await store.deriveValueValences(TENANT_A, llmH);
    check("5c 幻觉 value_id 被过滤（不写脏数据）", d2.derived === 1 && valenceOf(store, TENANT_A, "correct") === -1 && valenceOf(store, TENANT_A, "ghost-id") === undefined, JSON.stringify(d2));

    const llmBad = mockValenceLlm('{"valences":[{"value_id":"reliable","valence":2},{"value_id":"risk","valence":"1"}]}');
    const d3 = await store.deriveValueValences(TENANT_A, llmBad);
    check("5d 非法枚举（2 / 字符串）→ 该行 skipped 保持 NULL", d3.derived === 0 && valenceOf(store, TENANT_A, "reliable") === null && valenceOf(store, TENANT_A, "risk") === null, JSON.stringify(d3));

    const d4 = await store.deriveValueValences(TENANT_A, undefined);
    check("5e 无 runner → 安静跳过 {0,0}", d4.derived === 0 && d4.skipped === 0, JSON.stringify(d4));
  });
}

// ── 断言组 6：handler 降级面 ───────────────────────────────────────
console.log("\n[6] handler 降级面：无 runner → 503；store 不支持 → 503");
{
  await withTempStore("g6", async (store) => {
    const noRunner = await handleCoreMemoryValuesDerive({}, AUTH, "req-c2-6a", depsFor(store, ISO_A, { llm: undefined }));
    check("6a 无 LLM runner → 503（R3 降级可见）", noRunner.code === 503, `code=${noRunner.code}`);
    const failStore = { listValues: () => [], upsertValue: () => false, appendAudit: () => {} };
    const noSupport = await handleCoreMemoryValuesDerive({}, AUTH, "req-c2-6b", depsFor(failStore, ISO_A, { llm: mockValenceLlm("{}") }));
    check("6b store 不支持 deriveValueValences → 503", noSupport.code === 503, `code=${noSupport.code}`);
    const ok = await handleCoreMemoryValuesDerive({}, AUTH, "req-c2-6c", depsFor(store, ISO_A, { llm: mockValenceLlm('{"valences":[]}') }));
    check("6c 空表/空判定 → code=0 {derived:0,skipped:0}", ok.code === 0 && (ok.data as { derived: number }).derived === 0, JSON.stringify(ok));
    const noStore = await handleCoreMemoryValuesDerive({}, AUTH, "req-c2-6d", depsFor(undefined, ISO_A));
    check("6d store 缺失 → 503", noStore.code === 503, `code=${noStore.code}`);
  });
}

// ── 断言组 7：upsert valence clamp 三值 + 非法 → 400 ───────────────
console.log("\n[7] upsert valence：clamp 三值 + 校验");
{
  await withTempStore("g7", async (store) => {
    const r1 = await handleCoreMemoryValuesUpsert({ value_id: "v1", label: "x", weight: 0.5, valence: 0.6 }, AUTH, "req-7a", depsFor(store, ISO_A));
    check("7a valence=0.6 → clamp 1", r1.code === 0 && valenceOf(store, TENANT_A, "v1") === 1, `code=${r1.code} valence=${String(valenceOf(store, TENANT_A, "v1"))}`);
    const r2 = await handleCoreMemoryValuesUpsert({ value_id: "v2", label: "x", weight: 0.5, valence: -0.4 }, AUTH, "req-7b", depsFor(store, ISO_A));
    check("7b valence=-0.4 → clamp 0", r2.code === 0 && valenceOf(store, TENANT_A, "v2") === 0, `valence=${String(valenceOf(store, TENANT_A, "v2"))}`);
    const r3 = await handleCoreMemoryValuesUpsert({ value_id: "v3", label: "x", weight: 0.5, valence: "high" }, AUTH, "req-7c", depsFor(store, ISO_A));
    check("7c valence 非数字 → 400", r3.code === 400, `code=${r3.code}`);
    const r4 = await handleCoreMemoryValuesUpsert({ value_id: "v4", label: "x", weight: 0.5, valence: Number.NaN }, AUTH, "req-7d", depsFor(store, ISO_A));
    check("7d valence=NaN → 400", r4.code === 400, `code=${r4.code}`);
  });
}

// ── 断言组 8：租户隔离 ─────────────────────────────────────────────
console.log("\n[8] 租户隔离：A 的 derive 只判 A 的 NULL 行");
{
  await withTempStore("g8", async (store) => {
    store.upsertValue("correct", "正确", 0.9, "verify", TENANT_A);
    store.upsertValue("correct", "正确", 0.9, "verify", TENANT_B);
    const llm = mockValenceLlm('{"valences":[{"value_id":"correct","valence":1}]}');
    await store.deriveValueValences(TENANT_A, llm);
    check("8a A 判成 1，B 保持 NULL", valenceOf(store, TENANT_A, "correct") === 1 && valenceOf(store, TENANT_B, "correct") === null,
      `A=${String(valenceOf(store, TENANT_A, "correct"))} B=${String(valenceOf(store, TENANT_B, "correct"))}`);
  });
}

// ── 断言组 9：渲染三态全链 ─────────────────────────────────────────
console.log("\n[9] 渲染三态：正/负/混合/0/NULL/未命中（真实 renderCurrentFeeling）");
{
  const cfg = (vals: Array<{ id: string; label: string; weight: number; valence?: number | null }>) =>
    ({ enabled: true, firedThreshold: 0.4, values: vals });
  const pos = renderCurrentFeeling("聊聊正确", cfg([{ id: "c", label: "正确", weight: 0.9, valence: 1 }]));
  check("9a valence=1 → 本轮方向：围绕【正确】推进", pos.includes("本轮方向：围绕【正确】推进"), JSON.stringify(pos));
  const neg = renderCurrentFeeling("聊聊风险", cfg([{ id: "r", label: "风险", weight: 0.9, valence: -1 }]));
  check("9b valence=-1 → 本轮方向：对【风险】保持审慎", neg.includes("本轮方向：对【风险】保持审慎"), JSON.stringify(neg));
  const mixed = renderCurrentFeeling("正确和风险", cfg([
    { id: "c", label: "正确", weight: 0.9, valence: 1 },
    { id: "r", label: "风险", weight: 0.9, valence: -1 },
  ]));
  check("9c 混合 → 两行并列（不合成）",
    mixed.includes("本轮方向：围绕【正确】推进") && mixed.includes("本轮方向：对【风险】保持审慎"), JSON.stringify(mixed));
  const zero = renderCurrentFeeling("聊聊中性", cfg([{ id: "n", label: "中性", weight: 0.9, valence: 0 }]));
  check("9d valence=0 → 不输出方向行", !zero.includes("本轮方向") && zero.includes("中性(n)"), JSON.stringify(zero));
  const nullV = renderCurrentFeeling("聊聊正确", cfg([{ id: "c", label: "正确", weight: 0.9, valence: null }]));
  check("9e valence=NULL → 不输出方向行（D1 兜底）", !nullV.includes("本轮方向"));
  const noField = renderCurrentFeeling("聊聊性能", cfg([{ id: "p", label: "性能", weight: 0.9 }]));
  check("9f valence 缺省（config.yaml fallback）→ 不输出方向行（存量兼容）", !noField.includes("本轮方向") && noField.includes("性能(p)"));
  // 9g：q="聊聊正确" 只命中"正确"，"风险"未 fired → 不应出现在方向行
  const firedOnly = renderCurrentFeeling("聊聊正确", cfg([
    { id: "c", label: "正确", weight: 0.9, valence: 1 },
    { id: "r", label: "风险", weight: 0.9, valence: -1 },
  ]));
  check("9g 未 fired 的值不进方向行", firedOnly.includes("围绕【正确】推进") && !firedOnly.includes("对【风险】保持审慎"), JSON.stringify(firedOnly));
}

// ── 断言组 10：Critical-1 并发守卫（LLM 窗口内微调不被覆盖）─────────
console.log("\n[10] Critical-1 并发守卫：LLM 判定窗口内用户微调（upsert 带 valence）不被覆盖");
{
  await withTempStore("g10", async (store) => {
    store.upsertValue("correct", "正确", 0.9, "verify", TENANT_A);
    store.upsertValue("reliable", "可靠", 0.8, "verify", TENANT_A);
    // 可编程挂起的 mock LLMRunner：run() 进入后挂起（未 resolve = 判定窗口），等窗口内
    // 微调先落库再放行 → 复现"SELECT NULL 清单后、30s LLM 窗口内用户微调落库"竞态。
    let releaseLlm!: () => void;
    const gate = new Promise<void>((r) => { releaseLlm = r; });
    let llmEntered = false;
    const llm = {
      run: async () => {
        llmEntered = true;
        await gate;
        return '{"valences":[{"value_id":"correct","valence":1},{"value_id":"reliable","valence":-1}]}';
      },
    };
    const derivePromise = store.deriveValueValences(TENANT_A, llm as never);
    for (let i = 0; i < 100 && !llmEntered; i++) await new Promise((r) => setTimeout(r, 10));
    check("10a 前置：LLM run 已进入并挂起（判定窗口开启）", llmEntered);
    const tune = await handleCoreMemoryValuesUpsert(
      { value_id: "correct", label: "正确", weight: 0.9, valence: -1 },
      AUTH, "req-c2-10a", depsFor(store, ISO_A),
    );
    check("10b 窗口内微调落库（correct=-1）", tune.code === 0 && valenceOf(store, TENANT_A, "correct") === -1,
      `code=${tune.code} valence=${String(valenceOf(store, TENANT_A, "correct"))}`);
    releaseLlm();
    const d = await derivePromise;
    check("10c 微调值不被 LLM 判定覆盖（correct 保持 -1）", valenceOf(store, TENANT_A, "correct") === -1,
      `got=${String(valenceOf(store, TENANT_A, "correct"))}`);
    check("10d 其余 NULL 行正常判定（reliable=-1）", valenceOf(store, TENANT_A, "reliable") === -1,
      `got=${String(valenceOf(store, TENANT_A, "reliable"))}`);
    check("10e derived=真实生效数（changes 口径，被守卫拦截行不计数）", d.derived === 1 && d.skipped === 1, JSON.stringify(d));
  });
}

// ── 断言组 11：Important-1 apply-after-success（reset 失败恢复快照）──
console.log("\n[11] Important-1：reset+LLM 失败 → 原值恢复；成功 → 新值生效；部分成功 → 有效应用+无效恢复");
{
  await withTempStore("g11", async (store) => {
    // 前置：两行微调值（将被 reset 语义覆盖的对象）
    await handleCoreMemoryValuesUpsert({ value_id: "correct", label: "正确", weight: 0.9, valence: 1 }, AUTH, "req-c2-11a", depsFor(store, ISO_A));
    await handleCoreMemoryValuesUpsert({ value_id: "risk", label: "风险", weight: 0.8, valence: -1 }, AUTH, "req-c2-11b", depsFor(store, ISO_A));
    // ① reset + LLM 抛错 → 全部从快照恢复（修补前：微调值永久丢失）
    const llmThrow = { run: async (): Promise<string> => { throw new Error("llm down"); } };
    await handleCoreMemoryValuesDerive({}, AUTH, "req-c2-11c", depsFor(store, ISO_A, { llm: llmThrow as never }));
    check("11a reset+LLM 抛错 → 微调值从快照恢复（correct=1, risk=-1）",
      valenceOf(store, TENANT_A, "correct") === 1 && valenceOf(store, TENANT_A, "risk") === -1,
      `correct=${String(valenceOf(store, TENANT_A, "correct"))} risk=${String(valenceOf(store, TENANT_A, "risk"))}`);
    // ② reset + LLM 垃圾输出（全不可用）→ 全部恢复；响应仍 code=0（恢复语义，非 5xx）
    const d2 = await handleCoreMemoryValuesDerive({}, AUTH, "req-c2-11d", depsFor(store, ISO_A, { llm: mockValenceLlm("garbage") }));
    check("11b reset+LLM 垃圾输出 → 原值恢复",
      valenceOf(store, TENANT_A, "correct") === 1 && valenceOf(store, TENANT_A, "risk") === -1,
      `correct=${String(valenceOf(store, TENANT_A, "correct"))} risk=${String(valenceOf(store, TENANT_A, "risk"))}`);
    check("11c 全不可用响应 code=0 且 derived=0（恢复而非报错）",
      d2.code === 0 && (d2.data as { derived: number }).derived === 0, JSON.stringify(d2));
    // ③ reset + LLM 成功 → 新值生效（重判闭环语义不变）
    const d3 = await handleCoreMemoryValuesDerive({}, AUTH, "req-c2-11e", depsFor(store, ISO_A,
      { llm: mockValenceLlm('{"valences":[{"value_id":"correct","valence":-1},{"value_id":"risk","valence":1}]}') }));
    check("11d reset+LLM 成功 → 新值生效（correct=-1, risk=1）",
      d3.code === 0 && valenceOf(store, TENANT_A, "correct") === -1 && valenceOf(store, TENANT_A, "risk") === 1,
      `correct=${String(valenceOf(store, TENANT_A, "correct"))} risk=${String(valenceOf(store, TENANT_A, "risk"))}`);
    // ④ 部分成功 → 有效行应用 + 无效行从快照恢复（先恢复前置微调值）
    await handleCoreMemoryValuesUpsert({ value_id: "correct", label: "正确", weight: 0.9, valence: 1 }, AUTH, "req-c2-11f", depsFor(store, ISO_A));
    await handleCoreMemoryValuesUpsert({ value_id: "risk", label: "风险", weight: 0.8, valence: -1 }, AUTH, "req-c2-11g", depsFor(store, ISO_A));
    const d4 = await handleCoreMemoryValuesDerive({}, AUTH, "req-c2-11h", depsFor(store, ISO_A,
      { llm: mockValenceLlm('{"valences":[{"value_id":"correct","valence":-1},{"value_id":"risk","valence":5}]}') }));
    check("11e 部分成功：有效行应用新值（correct=-1）", valenceOf(store, TENANT_A, "correct") === -1,
      `got=${String(valenceOf(store, TENANT_A, "correct"))}`);
    check("11f 部分成功：无效行（非法枚举）从快照恢复原值（risk=-1）", valenceOf(store, TENANT_A, "risk") === -1,
      `got=${String(valenceOf(store, TENANT_A, "risk"))}`);
    check("11g 部分成功 derived=1 skipped=1", d4.code === 0 && (d4.data as { derived: number }).derived === 1 && (d4.data as { skipped: number }).skipped === 1, JSON.stringify(d4.data));
  });
}

console.log("\n" + "=".repeat(72));
console.log(`C2 结果：${pass} passed, ${fail} failed`);
console.log("=".repeat(72));
if (fail > 0) process.exit(1);
