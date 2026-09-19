/**
 * F-EV13-1（REG-REMAINING-006 A-7）RED 套件：身份事实↔语料措辞断链。
 *
 * 实证（ev13 真数据 2026-09-19）：
 *  - self_identity 槽事实（identity-discovery 的 LLM 提炼措辞）与 L1 语料（l1-extractor
 *    的 LLM 措辞）必然微差（"我承诺…" vs "我在对话中承诺…"）；
 *  - identityFactSlice 20 字前缀逐字包含 → identityRefs 回填 0 条（应为 2+）、
 *    GROW-MAINT unsupported=2 全假阳、character 提案「守诺」有支撑仍被证据门拒采；
 *  - 三处共用同一断链口径，违反自生长/自维护（身份证据链不生、F14 身份保护静默失效）。
 *
 * 修复：单一源匹配器 identityFactMatchesCorpus——fact 的 12 字滑窗在语料行任一命中
 * 即判定（确定性纯函数，≥12 连续汉字=强信号，无需信任 LLM；<4 字回退整串包含）。
 * 四消费面统一换用：identityRefs 回填 / GROW-MAINT / character 证据门 / isRefProtected
 * （旧 20 字切片引用向后兼容：fact[0:12] ⊂ ref 恒真）。
 */
import { describe, it, expect, vi } from "vitest";
import { identityFactMatchesCorpus } from "./identity-discovery.js";
import { maintainIdentityFacts } from "./anchor-growth.js";
import { isRefProtected } from "./forgetting/scorer.js";
import { runAnchorGrowth } from "./anchor-growth.js";

const NOW = new Date("2026-09-10T12:00:00.000Z");
const LOG = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
const FACT = "我承诺每周五出周报并坚持执行，近两个周五（9月11日、9月18日）的周报均已按时发出，这是我与用户共同维护的核心例行职责。";
const PARAPHRASE = "我在对话中承诺每周五出周报并坚持执行，近两个周五（9月11日、9月18日）的周报均已按时发出。";

describe("identityFactMatchesCorpus（单一源匹配器）", () => {
  it("措辞微差（12+ 连续公共子串）→ 命中", () => {
    expect(identityFactMatchesCorpus(FACT, PARAPHRASE)).toBe(true);
  });
  it("无关语料 → 不命中", () => {
    expect(identityFactMatchesCorpus(FACT, "用户今天午餐吃了面条，然后散步去了公园。")).toBe(false);
  });
  it("逐字包含（旧口径）仍命中（向后兼容）", () => {
    expect(identityFactMatchesCorpus(FACT, `前缀 ${FACT} 后缀`)).toBe(true);
  });
  it("短事实（<4 字）不命中（宁缺毋滥：2 字词裸包含误报面大）；空入参安全", () => {
    expect(identityFactMatchesCorpus("守诺", "他一向守诺，说到做到")).toBe(false); // 2 字太弱，需整串包含
    expect(identityFactMatchesCorpus("守诺", "守诺")).toBe(true);
    expect(identityFactMatchesCorpus("", "任意")).toBe(false);
    expect(identityFactMatchesCorpus(FACT, "")).toBe(false);
  });
});

describe("GROW-MAINT 身份重验（措辞断链假阳消除）", () => {
  it("槽事实有措辞微差的语料支撑 → unsupported=0（不再假阳）", async () => {
    const store = { readCore: () => [{ slot: "identity", content: `- ${FACT}` }] };
    const unsupported = await maintainIdentityFacts(store as never, { teamId: "t", userId: "u", agentId: "a" }, [PARAPHRASE], LOG);
    expect(unsupported).toBe(0);
  });
  it("真失撑（语料无任何相关）→ 仍告警（F20 语义保持）", async () => {
    const store = { readCore: () => [{ slot: "identity", content: `- ${FACT}` }] };
    const unsupported = await maintainIdentityFacts(store as never, { teamId: "t", userId: "u", agentId: "a" }, ["完全无关的内容而已"], LOG);
    expect(unsupported).toBe(1);
  });
});

describe("isRefProtected 身份引用模糊匹配", () => {
  const facts = new Set([FACT]);
  it("引用为事实片段（旧 20 字切片或新匹配窗）→ 保护", () => {
    expect(isRefProtected({ identityRefs: [FACT.slice(0, 20)] }, new Set(), facts)).toBe(true);
    expect(isRefProtected({ identityRefs: ["我承诺每周五出周报并坚持执"] }, new Set(), facts)).toBe(true);
  });
  it("引用与任何现行事实无 12 字重叠 → 不保护（悬空语义保持）", () => {
    expect(isRefProtected({ identityRefs: ["今天天气不错啊哈哈哈哈哈哈"] }, new Set(), facts)).toBe(false);
  });
});

describe("character 采纳（改写语料，ev13 活体形态）", () => {
  it("提案 fact=槽事实、语料为改写措辞 → 证据门命中并采纳 c- 锚", async () => {
    const rows = [
      { record_id: "r1", content: PARAPHRASE, type: "persona", priority: 0.5, scene_name: "", session_key: "", session_id: "s1", team_id: "t", task_id: "", user_id: "u", agent_id: "a", version: 1, timestamp_str: "2026-09-09T00:00:00Z", timestamp_start: "2026-09-09T00:00:00Z", timestamp_end: "2026-09-09T00:00:00Z", created_time: "2026-09-09T00:00:00Z", updated_time: "2026-09-09T00:00:00Z", metadata_json: "{}", valence: null },
      { record_id: "r2", content: PARAPHRASE, type: "persona", priority: 0.5, scene_name: "", session_key: "", session_id: "s1", team_id: "t", task_id: "", user_id: "u", agent_id: "a", version: 1, timestamp_str: "2026-09-09T00:00:00Z", timestamp_start: "2026-09-09T00:00:00Z", timestamp_end: "2026-09-09T00:00:00Z", created_time: "2026-09-09T00:00:00Z", updated_time: "2026-09-09T00:00:00Z", metadata_json: "{}", valence: null },
    ];
    const store = {
      queryL1Records: vi.fn(async () => rows),
      listValuesAnyState: vi.fn(async () => []),
      upsertValue: vi.fn(async () => true),
      retireValue: vi.fn(async () => true),
      getAnchorGrowthState: vi.fn(async () => ({ lastDiscoveryAt: null, lastCorpusCount: null })),
      setAnchorGrowthState: vi.fn(),
      backfillMemoryRef: vi.fn(() => true),
      readCore: vi.fn(() => [{ slot: "self_identity", content: `- ${FACT}` }]),
    };
    const runner = {
      run: vi.fn(async (p: { taskId: string }) => {
        if (p.taskId === "character-discover-growth") {
          return JSON.stringify([{ label: "守诺", rationale: "例行履约可复现", fact: FACT }]);
        }
        return "[]";
      }),
    };
    await runAnchorGrowth({
      store: store as never,
      llmRunner: runner as never,
      logger: LOG,
      now: () => NOW,
      config: { character: { enabled: true, minEvidence: 2, maxPerPass: 2, maxTotal: 8 } },
    });
    const calls = (store.upsertValue as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const up = calls.find((c) => c[1] === "守诺");
    expect(up).toBeTruthy(); // 修复前：证据门 0 命中 → 恒拒（RED）
    expect(String(up![0])).toMatch(/^c(-auto)?-/);
    expect(up![7]).toBe("character");
  });
});
