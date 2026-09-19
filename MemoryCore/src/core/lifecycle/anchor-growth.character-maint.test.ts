/**
 * F-EV12-5（REG-REMAINING-006 A-5）RED 套件：character 池三处不对称。
 * ① GROW-MAINT 维护口径：品格锚被 theme 口径 recountEvidence(label) 重算——
 *    品格词（"守诺"）不在语料字面出现 ≠ 品格无支撑（支撑=事实切片在语料），
 *    口径错配 → 误退场。修复：characterEvCount(现行 self_identity 槽切片) + cfg.character.minEvidence。
 * ② QUOTA 守卫：quotaEvict 只跑 theme/person——character 池超限无回归路径。修复：分池守卫同款。
 * ③ soul-feeling 仅主题锚（spec §2.7）：character 锚（derive 后 valence=±1）不得入感受段；
 *    价值锚行保留（spec §7「与主题锚共享注入预算」）。
 */
import { describe, it, expect, vi } from "vitest";
import { runAnchorGrowth } from "./anchor-growth.js";
import { buildSoulPrefix } from "../hooks/soul-assembler.js";
import type { CoreTenant } from "../store/types.js";

const NOW = new Date("2026-09-10T12:00:00.000Z");
const LOG = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
const T: CoreTenant = { teamId: "t", userId: "u", agentId: "a" };

function corpusRow(id: string, content: string) {
  return {
    record_id: id, content, type: "episodic", priority: 0.5, scene_name: "", session_key: "",
    session_id: "s1", team_id: "t", task_id: "", user_id: "u", agent_id: "a",
    version: 1, timestamp_str: "2026-09-09T00:00:00Z", timestamp_start: "2026-09-09T00:00:00Z", timestamp_end: "2026-09-09T00:00:00Z",
    created_time: "2026-09-09T00:00:00Z", updated_time: "2026-09-09T00:00:00Z", metadata_json: "{}", valence: null,
  };
}

function charRow(id: string, label: string, weight: number, facts: string[]) {
  return {
    value_id: `c-${id}`, label, weight, created_by: "auto-growth", valence: null,
    origin: "auto", pinned: 0, state: "active", team_id: "t", user_id: "u", agent_id: "a",
    node_type: "character", attrs_json: JSON.stringify({ source: "self_identity", facts }),
  };
}

function makeStore(rows: unknown[], values: unknown[], selfSlotContent: string) {
  return {
    queryL1Records: vi.fn(async () => rows),
    listValuesAnyState: vi.fn(async () => values),
    upsertValue: vi.fn(async () => true),
    retireValue: vi.fn(async () => true),
    getAnchorGrowthState: vi.fn(async () => ({ lastDiscoveryAt: null, lastCorpusCount: null })),
    setAnchorGrowthState: vi.fn(),
    backfillMemoryRef: vi.fn(() => true),
    readCore: vi.fn(() => (selfSlotContent ? [{ slot: "self_identity", content: selfSlotContent }] : [])),
  };
}

function makeRunner(replies: Record<string, string>) {
  return {
    run: vi.fn(async (p: { taskId: string }) => replies[p.taskId] ?? "[]"),
  };
}

const FACT = "我承诺每周五出周报并坚持执行";

describe("F-EV12-5① · GROW-MAINT 品格锚事实切片口径", () => {
  it("语料支撑事实切片但不含品格词字面 → 不误退（且 reweight 不漂 node_type）", async () => {
    const rows = [
      corpusRow("r1", `${FACT}，用户当周确认收到`),
      corpusRow("r2", `回顾：${FACT}（第三周）`),
      corpusRow("r3", `周报归档：${FACT} 已执行`),
    ];
    const char = charRow("c1", "守诺", 0.55, [FACT]);
    const store = makeStore(rows, [char], `- ${FACT}`);
    const runner = makeRunner({});
    await runAnchorGrowth({
      store: store as never,
      llmRunner: runner as never,
      logger: LOG,
      now: () => NOW,
      config: { character: { enabled: true, minEvidence: 2, maxPerPass: 1, maxTotal: 8 } },
    });
    // 修复前：recountEvidence("守诺")=0 < theme minEvidence → retireValue("c-c1") 被调用（误退）
    const retireCalls = (store.retireValue as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(retireCalls.some((c) => c[0] === "c-c1")).toBe(false);
    // reweight（如有）不得把 node_type 漂成 theme
    for (const c of (store.upsertValue as unknown as { mock: { calls: unknown[][] } }).mock.calls) {
      if (c[0] === "c-c1") expect(c[7]).toBe("character");
    }
  });
});

describe("F-EV12-5② · character 池 QUOTA 守卫", () => {
  it("超限（3>maxTotal 2）→ 按强度升序退场最弱者，恰好一个", async () => {
    const rows = [
      corpusRow("r1", `${FACT} A`),
      corpusRow("r2", `${FACT} B`),
    ];
    const values = [
      charRow("strong", "守诺", 0.34, [FACT]),
      charRow("mid", "严谨", 0.32, [FACT]),
      charRow("weak", "坦诚", 0.3, [FACT]),
    ];
    const store = makeStore(rows, values, `- ${FACT}`);
    const runner = makeRunner({});
    await runAnchorGrowth({
      store: store as never,
      llmRunner: runner as never,
      logger: LOG,
      now: () => NOW,
      config: { character: { enabled: true, minEvidence: 1, maxPerPass: 1, maxTotal: 2 } },
    });
    const retireCalls = (store.retireValue as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .filter((c) => typeof c[0] === "string" && (c[0] as string).startsWith("c-"));
    expect(retireCalls).toHaveLength(1);
    expect(retireCalls[0]![0]).toBe("c-weak");
  });
});

describe("F-EV12-5③ · soul-feeling 仅主题锚（character 不入感受段）", () => {
  it("character 锚 valence=1 → 价值锚行在场、感受段不在场", async () => {
    const store = {
      readCore: async () => [{ slot: "identity", content: "- 用户是团队负责人" }],
      listValues: async () => [
        { label: "交付质量", weight: 0.7, valence: 1, state: "active", node_type: "theme", attrs_json: "{}" },
        { label: "守诺", weight: 0.5, valence: 1, state: "active", node_type: "character", attrs_json: JSON.stringify({ source: "self_identity", facts: [FACT] }) },
      ],
    };
    const out = await buildSoulPrefix(store as never, T, LOG, { selfIdentityEnabled: true, budgetSelfChars: 600, budgetIdentityChars: 900, maxRelationLines: 5 });
    // 价值锚行：character 在场（共享注入预算）
    expect(out).toContain("价值锚：");
    expect(out).toContain("守诺");
    // 感受段：仅主题锚——守诺不得出现
    const feel = out.split("<soul-feeling>")[1] ?? "";
    expect(feel).toContain("交付质量");
    expect(feel).not.toContain("守诺");
  });
});
