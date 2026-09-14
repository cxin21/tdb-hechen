/**
 * F4 验证：巩固幂等 + 租户继承。
 * mock store（内存 + 记录 upsertL1 调用），两次 runConsolidation 同 subject 应复用 record_id、version 递增，
 * 且持续态继承源记忆的 team/user/agent。
 * 用法: node --import tsx scripts/audit-fix-verify-f4.ts
 */
import { runConsolidation } from "../src/core/lifecycle/consolidation/consolidation-worker.js";
import type { IMemoryStore } from "../src/core/store/types.js";

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } }

const SOURCE = [
  // 同一 subject "数据库连接池" 3 条，跨期满足 minCount=3/minSpanDays=1，带租户归属
  { id: "s1", content: "数据库连接池: 生产池太小导致超时", type: "episodic", priority: 50, timestamps: ["2026-09-01T00:00:00Z"], metadata: {}, occurred_at: "2026-09-01T00:00:00Z", teamId: "t1", userId: "u1", agentId: "a1" },
  { id: "s2", content: "数据库连接池: 调大后延迟下降", type: "episodic", priority: 60, timestamps: ["2026-09-02T00:00:00Z"], metadata: {}, occurred_at: "2026-09-02T00:00:00Z", teamId: "t1", userId: "u1", agentId: "a1" },
  { id: "s3", content: "数据库连接池: 已稳定不再报错", type: "episodic", priority: 70, timestamps: ["2026-09-03T00:00:00Z"], metadata: {}, occurred_at: "2026-09-03T00:00:00Z", teamId: "t1", userId: "u1", agentId: "a1" },
] as any[];

function mkStore() {
  const upserts: any[] = [];
  const links: any[] = [];
  const store = {
    upsertL1(rec, emb) { upserts.push(rec); return true; },
    addLink(s, t, type, strength) { links.push({ s, t, type, strength }); return true; },
  } as unknown as IMemoryStore;
  return { store: store as any as { upserts: any[]; links: any[] }, upserts, links };
}

async function runOnce(mockLLMContent: string, existing: any[]) {
  const msg = { subject: "", prompt: "", systemPrompt: "", raw: mockLLMContent };
  const llmRunner = { run: async (p: any) => JSON.stringify({ content: mockLLMContent }) } as any;
  const { store, upserts, links } = mkStore();
  const res = await runConsolidation({
    queryL1: async () => [...existing, ...SOURCE] as any,
    llmRunner,
    config: { enabled: true, persist: true, minCount: 3, minSpanDays: 1, maxPerRun: 10 },
    store,
    logger: { info: () => {}, debug: () => {}, warn: () => {} } as any,
  });
  return { res, upserts, links };
}

(async () => {
  console.log("== F4.1 幂等：同 subject 两次 run，应复用同一 record_id、version 递增 ==");
  const run1 = await runOnce("数据库连接池已调大并稳定", []);
  check("run1 产出 1 条持续态", run1.res.persisted === 1);
  check("run1 persisted=1（summaries=1）", run1.res.summaries.length === 1);
  const dur1 = run1.upserts[0];
  check("run1 持续态含 subject metadata", (dur1.metadata?.subject) === "数据库连接池");
  check("run1 version=1", dur1.version === 1);
  check("run1 继承 teamId", dur1.teamId === "t1");
  check("run1 继承 userId", dur1.userId === "u1");
  check("run1 继承 agentId", dur1.agentId === "a1");
  check("run1 建 part_of 边 3 条", run1.links.length === 3);

  const run2 = await runOnce("数据库连接池稳定性确认", [dur1]);
  check("run2 persisted=1（复用既有）", run2.res.persisted === 1);
  const dur2 = run2.upserts[0];
  check("run2 复用同一 record_id", run2.upserts.length === 1 && dur2.id === dur1.id);
  check("run2 version=2（递增）", dur2.version === 2);
  check("run2 继续继承租户", dur2.teamId === "t1" && dur2.userId === "u1" && dur2.agentId === "a1");

  console.log("== F4.2 work_fact 不作为源记忆参与分组 ==");
  const run3 = await runOnce("新结论", [dur1, durself()]);
  // durself: work_fact / scene consolidated 的记忆——不应进源分组
  check("work_fact 不新增个人 subject 组（仍 1 组）", run3.res.groupsFound === 1);

  function durself() {
    return {
      id: "dur_old_1", content: "数据库连接池旧摘要", type: "work_fact", priority: 80,
      scene_name: "consolidated", timestamps: ["2026-09-01T00:00:00Z"],
      metadata: { subject: "数据库连接池的其他子域" }, occurred_at: "2026-09-01T00:00:00Z",
      version: 1, teamId: "t9", userId: "u9", agentId: "a9",
    };
  }

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
})();