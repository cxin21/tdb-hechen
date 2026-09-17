/**
 * P2 Task 4（spec §5 F15 身份分支 / F20 红线）：identity GROW-MAINT 只警告 + identityRefs 回填。
 * F20 verbatim：身份事实永不自动退场——失撑只发警告（人工确认路径），upsertCore 零调用。
 */
import { describe, it, expect, vi } from "vitest";
import { runIdentityDiscovery, identityFactSlice } from "./identity-discovery.js";
import { maintainIdentityFacts } from "./anchor-growth.js";

const TENANT = { teamId: "t", userId: "u", agentId: "a" };

describe("identityFactSlice 弱口径单源", () => {
  it("剥 bulleted 前缀；超 20 字截断；短句原样", () => {
    expect(identityFactSlice("- 我负责技术评审")).toBe("我负责技术评审");
    expect(identityFactSlice("x".repeat(30)).length).toBe(20);
    expect(identityFactSlice("短句")).toBe("短句");
  });
});

describe("maintainIdentityFacts（F20 只警告）", () => {
  const CORE = [{ slot: "identity", content: "- 用户是家里的首席厨师\n- 用户每周日陪女儿去图书馆" }];

  function makeStore(core: Array<{ slot: string; content: string }>) {
    return { readCore: () => core, upsertCore: vi.fn(() => true), retireValue: vi.fn(() => true) };
  }
  function makeLogger() {
    const warns: string[] = [];
    return { warns, logger: { warn: (m: string) => warns.push(m), info: () => {}, debug: () => {}, error: () => {} } };
  }

  it("失撑事实 warn 一次且永不写库（F20）", async () => {
    const store = makeStore(CORE);
    const { warns, logger } = makeLogger();
    const corpus = ["用户是家里的首席厨师，周末为全家掌勺"];
    const n = await maintainIdentityFacts(store as never, TENANT, corpus, logger as never);
    expect(n).toBe(1);
    expect(warns[0]).toContain("warning-only");
    expect(warns[0]).toContain("F20");
    expect((store as unknown as { upsertCore: ReturnType<typeof vi.fn> }).upsertCore).not.toHaveBeenCalled();
    expect((store as unknown as { retireValue: ReturnType<typeof vi.fn> }).retireValue).not.toHaveBeenCalled();
  });

  it("全部有支撑 → 零告警", async () => {
    const store = makeStore(CORE);
    const { warns, logger } = makeLogger();
    const corpus = ["用户是家里的首席厨师，掌勺", "周日图书馆是用户陪女儿的固定安排"];
    const n = await maintainIdentityFacts(store as never, TENANT, corpus, logger as never);
    expect(n).toBe(0);
    expect(warns).toEqual([]);
  });

  it("无 identity 槽 / 空内容 → 0（零成本短路）", async () => {
    const store = makeStore([]);
    const { logger } = makeLogger();
    expect(await maintainIdentityFacts(store as never, TENANT, ["x"], logger as never)).toBe(0);
  });
});

describe("identity 采纳 → identityRefs 回填", () => {
  it("命中语料行按 20 字切片回填 identityRefs", async () => {
    const backfillMemoryRef = vi.fn((_rid: string, _key: string, _label: string) => true);
    const store = {
      queryL1Records: () => [
        { record_id: "r1", content: "用户把体检安排在周五，全家一起吃晚饭", significance: 0.9, updated_time: "2026-09-17T09:00:00Z" },
        { record_id: "r2", content: "无关记忆", significance: 0.1, updated_time: "2026-09-17T09:00:00Z" },
      ],
      countL1: () => 2,
      readCore: () => [] as Array<{ slot: string; content: string }>,
      upsertCore: () => true,
      getIdentityDiscoveryState: async () => ({ lastAttemptAt: null, lastCorpusCount: null }),
      setIdentityDiscoveryState: async () => {},
      backfillMemoryRef,
    } as never;
    const run = vi.fn().mockResolvedValue(JSON.stringify([
      { slot: "identity", content: "用户把体检安排在周五并全家聚餐", rationale: "多源" },
    ]));
    await runIdentityDiscovery({
      store, llmRunner: { run }, logger: undefined,
      config: { intervalHours: 24 }, selfIdentity: { enabled: true, maxPerPass: 2 },
      now: () => new Date("2026-09-17T10:00:00Z"),
    });
    const refs = backfillMemoryRef.mock.calls.filter((c) => c[1] === "identityRefs");
    expect(refs.length).toBeGreaterThanOrEqual(1);
    expect(refs.every((c) => c[0] === "r1")).toBe(true);
    expect(String(refs[0]![2])).toBe("用户把体检安排在周五并全家聚餐".slice(0, 20));
  });
});
