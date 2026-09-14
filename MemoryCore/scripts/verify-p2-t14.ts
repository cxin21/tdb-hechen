/**
 * P2-T14 同形验证：neighbors/lifecycle 租户过滤（G2 + H-B2）+ maxN clamp（G8）+ 混租户组校验。
 *
 * 背景：
 *   G2：/v3/atomic/neighbors handler 无 requestIsolation 消费——知道任意 record_id 即可
 *       跨租户枚举邻居+内容（content/certainty 等）。修复：store.getNeighbors 增可选
 *       IsolationFilter（两步过滤复用 rowMatchesIsolation），handler 消费租户上下文传入。
 *   G8：neighbors maxN 无上限 clamp → Math.min(maxN ?? 20, 50)。
 *   H-B2：巩固分组零租户隔离——lifecycle.filter 无法配置（config 无字段）、server 不传、
 *       混租户同前缀 subject 串组（B 租户内容进 A 租户摘要+evidence_ids）。
 *       修复：config 解析 filter + server 显式接线 + scheduler 派生补租户字段 +
 *       groupBySubject 组内租户一致性校验（数据级双保险，混租户组整组丢弃 + warn）。
 *
 * 断言组（验收契约）：
 *   1. neighbors 租户过滤：带 A filter → 只返回 A 的邻居；B 的 id 查询 → 空；
 *      不带 filter（显式 undefined）→ 行为与旧一致（兼容）。
 *   2. maxN=10^6 → clamp 生效（返回 ≤50）。
 *   3. lifecycle：scheduler filter 传 A → queryL1Records 只见 A 的行 → groups=0。
 *   4. 混租户组校验：不传 filter（旧行为）+ 双租户同前缀 → 组被丢弃 + warn。
 *   5. 单租户回归：filter 不传 → consolidation 行为与修复前一致（3 条 observed 同前缀仍触发）。
 *
 * 用法（在 MemoryCore 目录下）：
 *   node --import tsx scripts/verify-p2-t14.ts
 *
 * 只用自建临时库，不连任何线上资源、不碰生产数据目录；跑完自动清理临时目录。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { handleAtomicNeighbors } from "../src/gateway/v2-router.js";
import { runConsolidation } from "../src/core/lifecycle/consolidation/consolidation-worker.js";
import type { MemoryRecord } from "../src/core/record/l1-writer.js";
import { VectorStore } from "../src/core/store/sqlite.js";
import { startLifecycleScheduler } from "../src/core/lifecycle/lifecycle-scheduler.js";
import type { IsolationFilter } from "../src/core/store/types.js";

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

// ── fixture：MemoryRecord 构造（含租户字段） ─────────────────────────────
const TENANT_A: IsolationFilter = { teamId: "teamA", userId: "userA", agentId: "agentA" };
const TENANT_B: IsolationFilter = { teamId: "teamB", userId: "userB", agentId: "agentB" };

function mk(
  id: string,
  day: string,
  content: string,
  tenant: IsolationFilter,
  certainty = "observed",
): MemoryRecord {
  return {
    id,
    content,
    type: "episodic",
    priority: 70,
    scene_name: "s",
    source_message_ids: [],
    metadata: {},
    timestamps: [day], // occurredTs 第一优先来源；拉开天数以跨过 minSpanDays
    createdAt: day,
    updatedAt: day,
    version: 0,
    sessionKey: "k",
    sessionId: "verify-p2-t14",
    certainty,
    teamId: tenant.teamId,
    userId: tenant.userId,
    agentId: tenant.agentId,
  } as MemoryRecord;
}

function newStore(tmpDir: string, name: string): VectorStore {
  const store = new VectorStore(path.join(tmpDir, `${name}.db`), 0);
  const res = store.init();
  if (store.isDegraded()) {
    throw new Error(`临时库初始化降级（环境问题，非行为断言）：${JSON.stringify(res)}`);
  }
  return store;
}

// ── 断言组 1+2：neighbors 租户过滤 + maxN clamp ─────────────────────────

async function testNeighbors(tmpDir: string): Promise<void> {
  console.log("\n断言组 1 — neighbors 租户过滤（G2：两步过滤复用 rowMatchesIsolation）");
  const store = newStore(tmpDir, "neighbors");

  // 租户 A：a1—a2 互为邻居；跨租户边 a1—b1（泄漏探针）
  store.upsertL1(mk("a1", "2026-09-01T00:00:00Z", "租户A偏好本地部署：原因一", TENANT_A), undefined);
  store.upsertL1(mk("a2", "2026-09-02T00:00:00Z", "租户A偏好本地部署：原因二", TENANT_A), undefined);
  // 租户 B：b1 同前缀（巩固串组探针，本组内只有 1 条不触发巩固）
  store.upsertL1(mk("b1", "2026-09-03T00:00:00Z", "租户B偏好本地部署：原因一", TENANT_B), undefined);
  store.addLink("a1", "a2", "similar", 1);
  store.addLink("a1", "b1", "similar", 1);

  // 泄漏实锤（RED 期）：无 filter 时跨租户邻居 b1 出现在 a1 的邻居里
  const unfiltered = store.getNeighbors("a1", undefined, 1) as Array<{ id: string }>;
  const leakIds = unfiltered.map((n) => n.id);
  console.log(`  无 filter 基线：a1 邻居=${JSON.stringify(leakIds)}（含 b1=旧行为/兼容保留）`);

  // 兼容：显式 undefined → 行为与旧一致（跨租户邻居仍在）
  check(
    "1a 不带 filter（显式 undefined）→ 行为与旧一致（含跨租户 b1）",
    leakIds.includes("a2") && leakIds.includes("b1"),
    JSON.stringify(leakIds),
  );

  // A filter → 只返回 A 的邻居
  const aView = store.getNeighbors("a1", undefined, 1, TENANT_A) as Array<{ id: string }>;
  const aIds = aView.map((n) => n.id);
  check("1b A filter → 只见 a2", aIds.length === 1 && aIds[0] === "a2", JSON.stringify(aIds));

  // B 的 id 查询（B filter）→ 空（b1 的唯一邻居都是 A 的）
  const bView = store.getNeighbors("b1", undefined, 1, TENANT_B) as Array<{ id: string }>;
  check("1c B 的 id + B filter → 空（跨租户邻居不可见）", bView.length === 0, JSON.stringify(bView));

  // handler 端到端：requestIsolation 消费（知道 record_id 也不能跨租户枚举内容）
  console.log("\n断言组 1d — handler 消费 requestIsolation（返回内容字段只含过滤后的）");
  const envB = await handleAtomicNeighbors(
    { id: "b1", maxN: 10 },
    {} as never,
    "req-1d",
    { getStore: () => store, requestIsolation: { teamId: TENANT_B.teamId, userId: TENANT_B.userId, agentId: TENANT_B.agentId, sessionId: "s1" } } as never,
  );
  const neighborsB = ((envB as { data?: { neighbors?: Array<{ id: string; content?: string }> } }).data?.neighbors ?? []);
  check(
    "1d B 租户请求 b1 邻居 → 空数组（无 A 内容泄漏）",
    Array.isArray(neighborsB) && neighborsB.length === 0,
    JSON.stringify(neighborsB),
  );

  console.log("\n断言组 2 — maxN clamp（G8）");
  // hub + 55 条 A 邻居 + 5 条 B 邻居：A filter + maxN=10^6 → ≤50 且全 A
  store.upsertL1(mk("hub", "2026-08-31T00:00:00Z", "hub 节点", TENANT_A), undefined);
  for (let i = 0; i < 55; i++) {
    store.upsertL1(mk(`a_hub_${i}`, "2026-08-20T00:00:00Z", `A 批量邻居 ${i}`, TENANT_A), undefined);
    store.addLink("hub", `a_hub_${i}`, "similar", 1);
  }
  for (let i = 0; i < 5; i++) {
    store.upsertL1(mk(`b_hub_${i}`, "2026-08-20T00:00:00Z", `B 批量邻居 ${i}`, TENANT_B), undefined);
    store.addLink("hub", `b_hub_${i}`, "similar", 1);
  }
  const envClamp = await handleAtomicNeighbors(
    { id: "hub", maxN: 1_000_000 },
    {} as never,
    "req-2",
    { getStore: () => store, requestIsolation: { teamId: TENANT_A.teamId, userId: TENANT_A.userId, agentId: TENANT_A.agentId, sessionId: "s1" } } as never,
  );
  const neighborsClamp = ((envClamp as { data?: { neighbors?: Array<{ id: string; content?: string }> } }).data?.neighbors ?? []);
  const clampIds = neighborsClamp.map((n) => n.id);
  check("2a maxN=10^6 → clamp 生效（≤50）", neighborsClamp.length <= 50, `count=${neighborsClamp.length}`);
  check(
    "2b clamp 后仍带租户过滤（60 条边只回 50 条 A 邻居，无 B 内容）",
    neighborsClamp.length === 50 && clampIds.every((id) => !id.startsWith("b_hub_")),
    `count=${neighborsClamp.length} bCount=${clampIds.filter((id) => id.startsWith("b_hub_")).length}`,
  );
  const envDefault = await handleAtomicNeighbors(
    { id: "hub" },
    {} as never,
    "req-2c",
    { getStore: () => store, requestIsolation: { teamId: TENANT_A.teamId, userId: TENANT_A.userId, agentId: TENANT_A.agentId, sessionId: "s1" } } as never,
  );
  const neighborsDefault = ((envDefault as { data?: { neighbors?: Array<{ id: string }> } }).data?.neighbors ?? []);
  check("2c maxN 缺省 → 20（默认值不回归）", neighborsDefault.length === 20, `count=${neighborsDefault.length}`);
  // 终审 F-2：负数 maxN → slice 语义反转（slice(0,-1) 从尾部截）绕过上限 clamp。
  // A 视角 hub 有 55 条 A 邻居：修复前 maxN=-1 → slice(0,-1)=54 条（>50，护栏失效）；
  // 修复后 clamp 到 1 → 1 条。断言：≤50 且非"几乎全部"（≠54/55）。
  const envNeg = await handleAtomicNeighbors(
    { id: "hub", maxN: -1 },
    {} as never,
    "req-2d",
    { getStore: () => store, requestIsolation: { teamId: TENANT_A.teamId, userId: TENANT_A.userId, agentId: TENANT_A.agentId, sessionId: "s1" } } as never,
  );
  const neighborsNeg = ((envNeg as { data?: { neighbors?: Array<{ id: string }> } }).data?.neighbors ?? []);
  check(
    "2d maxN=-1 → 下界 clamp 生效（≤50 且非几乎全部）",
    neighborsNeg.length <= 50 && neighborsNeg.length < 54,
    `count=${neighborsNeg.length}`,
  );

  store.close();
}

// ── 断言组 3：lifecycle scheduler filter（H-B2 部署级） ─────────────────

async function testLifecycleFilter(tmpDir: string): Promise<void> {
  console.log("\n断言组 3 — lifecycle scheduler filter 传 A → 只见 A 的行 → groups=0");
  const store = newStore(tmpDir, "lifecycle");

  // A 2 条 + B 1 条同前缀：若 B 可见，凑满 3 条会触发巩固（泄漏探针）
  store.upsertL1(mk("la1", "2026-09-01T00:00:00Z", "租户A偏好容器化：原因一", TENANT_A), undefined);
  store.upsertL1(mk("la2", "2026-09-04T00:00:00Z", "租户A偏好容器化：原因二", TENANT_A), undefined);
  store.upsertL1(mk("lb1", "2026-09-07T00:00:00Z", "租户B偏好容器化：原因一", TENANT_B), undefined);

  const capturedFilters: Array<unknown> = [];
  const capturedRowCounts: number[] = [];
  const spyStore = Object.create(store) as VectorStore;
  (spyStore as unknown as { queryL1Records: (f?: unknown) => unknown }).queryL1Records = (f?: unknown) => {
    capturedFilters.push(f);
    const rows = store.queryL1Records(f as never);
    capturedRowCounts.push(rows.length);
    return rows;
  };

  const logs: string[] = [];
  const logger = {
    info: (m: string) => {
      logs.push(String(m));
      console.log(`  [lifecycle] ${m}`);
    },
    warn: (m: string) => {
      logs.push(String(m));
      console.log(`  [lifecycle:warn] ${m}`);
    },
    debug: () => {},
  };

  const stop = startLifecycleScheduler({
    store: spyStore as never,
    llmRunner: { run: async () => JSON.stringify({ content: "x", certainty: "observed" }) } as never,
    config: {
      enabled: true,
      intervalMs: 3_600_000,
      filter: { teamId: TENANT_A.teamId, userId: TENANT_A.userId, agentId: TENANT_A.agentId },
      consolidation: { enabled: true, minCount: 3, minSpanDays: 1, maxPerRun: 20 },
    },
    logger: logger as never,
  });

  // runOnce 启动即触发（fire-and-forget）——轮询等待 consolidation 日志行
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !logs.some((l) => l.includes("[lifecycle] consolidation groups="))) {
    await new Promise((r) => setTimeout(r, 100));
  }
  stop();
  store.close();

  const consolidationLog = logs.find((l) => l.includes("[lifecycle] consolidation groups=")) ?? "";
  const groupsMatch = /groups=(\d+)/.exec(consolidationLog);
  const groups = groupsMatch ? Number(groupsMatch[1]) : -1;

  check("3a scheduler 传 A filter → queryL1Records 收到该 filter", capturedFilters.length > 0 && JSON.stringify(capturedFilters[0]) === JSON.stringify({ teamId: "teamA", userId: "userA", agentId: "agentA" }), JSON.stringify(capturedFilters[0]));
  // PA（价值锚 per-agent 严格独立）断言更新：自生长挂钩现按 agent 三元组逐个查各自的
  // 语料（A→2 行、B→1 行，均带各自三元组 filter = 合法自读，非跨租户泄漏）。泄漏探针
  // 语义改为：任何一次查询都不得出现 3 行（A2+B1 的无过滤全量 = 泄漏形态）。
  check("3b 无泄漏：所有 queryL1Records 均按租户过滤（无 3 行全量；A=2、growth 的 B 自读=1）",
    capturedRowCounts.length > 0 && capturedRowCounts.every((c) => c < 3) && capturedRowCounts[0] === 2, JSON.stringify(capturedRowCounts));
  check("3c groups=0（B 的行凑不满 3 条，不触发巩固）", groups === 0, `groups=${groups} log="${consolidationLog}"`);
}

// ── 断言组 4+5：混租户组校验（数据级双保险）+ 单租户回归 ─────────────────

async function testGroupValidation(tmpDir: string): Promise<void> {
  console.log("\n断言组 4 — 混租户同前缀（不传 filter，旧行为）→ 组丢弃 + warn");
  const store = newStore(tmpDir, "grouping-mixed");

  const mixed = [
    mk("ma1", "2026-09-01T00:00:00Z", "用户偏好本地部署：原因一", TENANT_A),
    mk("ma2", "2026-09-04T00:00:00Z", "用户偏好本地部署：原因二", TENANT_A),
    mk("mb1", "2026-09-07T00:00:00Z", "用户偏好本地部署：原因一", TENANT_B),
  ];
  for (const m of mixed) store.upsertL1(m, undefined);

  // 复刻 lifecycle-scheduler 的真实查询路径（含修复后的租户字段派生）
  const queryL1 = async (filter?: unknown) => {
    const rows = store.queryL1Records(filter as never);
    return rows.map((r) => ({
      ...(r as object),
      teamId: (r as { team_id?: string }).team_id,
      userId: (r as { user_id?: string }).user_id,
      agentId: (r as { agent_id?: string }).agent_id,
      taskId: (r as { task_id?: string }).task_id,
      timestamps: [((r as { timestamp_start?: string }).timestamp_start ?? (r as { timestamp_str?: string }).timestamp_str ?? "")].filter(Boolean),
      metadata: {
        ...((r as { metadata?: object }).metadata ?? {}),
        activity_start_time: (r as { timestamp_start?: string }).timestamp_start ?? "",
        occurred_at: (r as { occurred_at?: string }).occurred_at ?? "",
      },
    })) as unknown as MemoryRecord[];
  };

  const warns: string[] = [];
  const llmPrompts: string[] = [];
  const res4 = await runConsolidation({
    queryL1: () => queryL1(undefined) as never, // 不传 filter（旧行为）
    llmRunner: {
      run: async (params: { prompt?: string; systemPrompt?: string }) => {
        llmPrompts.push(`${params.systemPrompt ?? ""}\n${params.prompt ?? ""}`);
        return JSON.stringify({ content: "（mock）不应被调用", certainty: "observed" });
      },
    } as never,
    config: { enabled: true, minCount: 3, minSpanDays: 1, maxPerRun: 20 },
    store,
    logger: {
      info: (m: string) => console.log(`  [worker] ${m}`),
      warn: (m: string) => {
        warns.push(String(m));
        console.log(`  [worker:warn] ${m}`);
      },
      debug: () => {},
    } as never,
  });

  const after4 = store
    .queryL1Records()
    .filter((r) => r.type === "work_fact" && r.scene_name === "consolidated");

  check("4a 混租户组被丢弃（groupsFound=0）", res4.groupsFound === 0, `groupsFound=${res4.groupsFound}`);
  check("4b LLM 未被调用（B 内容不进摘要）", llmPrompts.length === 0, `llmCalls=${llmPrompts.length}`);
  check("4c 无持续态落库（persisted=0 且 DB 无 consolidated 行）", res4.persisted === 0 && after4.length === 0, `persisted=${res4.persisted} dbRows=${after4.length}`);
  check("4d warn 告警含混租户提示（数据级双保险可见）", warns.some((w) => w.includes("租户") || w.toLowerCase().includes("tenant")), JSON.stringify(warns));

  console.log("\n断言组 5 — 单租户回归：filter 不传 → 行为与修复前一致");
  // 独立临时库：与断言组 4 隔离，避免同前缀跨组串味（组 4 的混租户组不影响本组）
  const store5 = newStore(tmpDir, "grouping-single");
  // 单租户 A 3 条 observed 同前缀（p0-t1 同形）→ 仍触发巩固
  const single = [
    mk("sa1", "2026-09-01T00:00:00Z", "用户偏好本地部署：原因一", TENANT_A),
    mk("sa2", "2026-09-04T00:00:00Z", "用户偏好本地部署：原因二", TENANT_A),
    mk("sa3", "2026-09-07T00:00:00Z", "用户偏好本地部署：原因三", TENANT_A),
  ];
  for (const m of single) store5.upsertL1(m, undefined);

  const queryL15 = async (filter?: unknown) => {
    const rows = store5.queryL1Records(filter as never);
    return rows.map((r) => ({
      ...(r as object),
      teamId: (r as { team_id?: string }).team_id,
      userId: (r as { user_id?: string }).user_id,
      agentId: (r as { agent_id?: string }).agent_id,
      taskId: (r as { task_id?: string }).task_id,
      timestamps: [((r as { timestamp_start?: string }).timestamp_start ?? (r as { timestamp_str?: string }).timestamp_str ?? "")].filter(Boolean),
      metadata: {
        ...((r as { metadata?: object }).metadata ?? {}),
        activity_start_time: (r as { timestamp_start?: string }).timestamp_start ?? "",
        occurred_at: (r as { occurred_at?: string }).occurred_at ?? "",
      },
    })) as unknown as MemoryRecord[];
  };

  const res5 = await runConsolidation({
    queryL1: () => queryL15(undefined) as never,
    llmRunner: {
      run: async () => JSON.stringify({ content: "（mock 持续态）用户持续偏好本地部署。", certainty: "observed" }),
    } as never,
    config: { enabled: true, minCount: 3, minSpanDays: 1, maxPerRun: 20 },
    store: store5,
    logger: {
      info: (m: string) => console.log(`  [worker] ${m}`),
      warn: (m: string) => console.log(`  [worker:warn] ${m}`),
      debug: () => {},
    } as never,
  });
  const after5 = store5
    .queryL1Records()
    .filter((r) => r.type === "work_fact" && r.scene_name === "consolidated");
  check("5a 单租户同前缀仍触发巩固（groupsFound=1）", res5.groupsFound === 1, `groupsFound=${res5.groupsFound}`);
  check("5b 持续态落库且租户继承发起方 A", res5.persisted === 1 && after5.length === 1 && after5[0].team_id === "teamA", `persisted=${res5.persisted} team_id=${after5[0]?.team_id}`);

  store.close();
  store5.close();
}

// ── main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=== P2-T14 同形验证 ===");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-p2-t14-"));
  let hardFail = false;
  try {
    await testNeighbors(tmpDir);
    await testLifecycleFilter(tmpDir);
    await testGroupValidation(tmpDir);
  } catch (err) {
    hardFail = true;
    console.error("verify script crashed:", err);
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
