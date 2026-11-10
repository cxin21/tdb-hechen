/**
 * task-6（2026-11-07）：人格注入退役后的 `buildSoulPrefix` 合同。
 *
 * 背景：人格注入移交 DSH 插件两段（`dsh-plugin/src/persona-card.ts` 的 systemPrompt section +
 * 每轮 volatile ≤400 字符），Core 只提供 `GET /v3/soul/card` 与 `/v3/soul/turn`。于是
 * `buildSoulPrefix` 从「人格全量渲染」降级为「只渲染当下状态/心境」，本文件钉住新合同：
 *   ① 只有 `<soul-feeling>` 一段，永远不产身份段 / 人格段 / 红线 / 价值锚 / 承诺 / capabilities；
 *   ② 不读 `core_memory` 槽、不读 `soul_persona`、不写 `soul_snapshots`（唯一写者归 card-service）；
 *   ③ 既无 moodTier 也无 soulMood/state → 返回空串（宁缺毋滥，不造空段）；
 *   ④ 仍导出 `computeSoulVersion` / `isDanglingTail`（生产有消费方）。
 */
import { describe, expect, it } from "vitest";
import { buildSoulPrefix, computeSoulVersion, isDanglingTail } from "../soul-assembler.js";

const TENANT = { teamId: "t-task6", userId: "u-task6", agentId: "a-task6" };

type PrefixStore = Parameters<typeof buildSoulPrefix>[0];

interface ProbeCalls {
  readCore: number;
  listValues: number;
  listSoulPersona: number;
  readSoulState: number;
  writeSoulSnapshot: number;
}

/**
 * store 探针：任何「旧链输入面」的触碰都会被记下来。人格渲染退役后这些读都不该发生——
 * 真被调用也只是返回夹具（不会抛），这样断言给出的是「零调用」而不是「崩了」。
 */
function probeStore(
  slots: Array<{ slot: string; content: string }> = [],
  persona: Array<Record<string, unknown>> = [],
): { store: PrefixStore; calls: ProbeCalls } {
  const calls: ProbeCalls = { readCore: 0, listValues: 0, listSoulPersona: 0, readSoulState: 0, writeSoulSnapshot: 0 };
  const store = {
    readCore: () => {
      calls.readCore += 1;
      return slots;
    },
    listValues: () => {
      calls.listValues += 1;
      return [];
    },
    listSoulPersona: () => {
      calls.listSoulPersona += 1;
      return persona;
    },
    readSoulState: () => {
      calls.readSoulState += 1;
      return null;
    },
    writeSoulSnapshot: () => {
      calls.writeSoulSnapshot += 1;
      return true;
    },
  };
  return { store: store as unknown as PrefixStore, calls };
}

const PERSONA_FIXTURE = [
  { itemId: "persona:t1", layer: "identity", text: "先取证再改代码", state: "active", weight: 0.8 },
];
const SLOT_FIXTURE = [
  { slot: "self_identity", content: "我是测试主体。" },
  { slot: "identity", content: "对端是系统维护者。" },
  { slot: "strict_rule", content: "绝不可删除记忆。" },
];

describe("task-6 · buildSoulPrefix 只出 <soul-feeling>（人格已移交插件）", () => {
  it("既无 moodTier 也无 soulMood/state → 空串（宁缺毋滥，不造空段）", async () => {
    const { store, calls } = probeStore(SLOT_FIXTURE, PERSONA_FIXTURE);
    const out = await buildSoulPrefix(store, TENANT);
    expect(out).toBe("");
    expect(calls.readCore).toBe(0);
    expect(calls.listSoulPersona).toBe(0);
    expect(calls.writeSoulSnapshot).toBe(0);
  });

  it("只有 moodTier → 单段 soul-feeling，只含基调行，无身份/人格/红线/价值锚", async () => {
    const { store } = probeStore(SLOT_FIXTURE, PERSONA_FIXTURE);
    const out = await buildSoulPrefix(store, TENANT, undefined, {
      moodTier: { tier: "strained", sampleCount: 20 },
    });
    expect(out.startsWith("<soul-feeling>\n## 当下的状态\n")).toBe(true);
    expect(out.endsWith("\n</soul-feeling>\n\n")).toBe(true);
    expect(out).toContain("近期基调：偏承压。");
    // 单段：不许出现第二个 soul-feeling，也不许出现旧四段里的任何一个。
    expect(out.match(/<\/soul-feeling>/g)).toHaveLength(1);
    expect(out).not.toContain("<soul-identity>");
    expect(out).not.toContain("<soul-persona>");
    expect(out).not.toContain("## 不可逾越（红线）");
    expect(out).not.toContain("价值锚");
    expect(out).not.toContain("我的承诺");
    expect(out).not.toContain("我能做什么");
    expect(out).not.toContain("我是测试主体。");
    expect(out).not.toContain("先取证再改代码");
  });

  it("槽 / 人格 / 承诺齐备也不读输入面（零调用：不读槽、不读人格、不写快照）", async () => {
    const { store, calls } = probeStore(SLOT_FIXTURE, PERSONA_FIXTURE);
    const out = await buildSoulPrefix(
      store,
      TENANT,
      undefined,
      {
        // 2026-11-07 task-12：旧开关字段已从 SoulRenderOptions 删除，只剩真正被消费的四项。
        moodTier: { tier: "neutral", sampleCount: 5 },
      },
    );
    expect(out).toContain("近期基调：平稳。");
    expect(calls.readCore).toBe(0);
    expect(calls.listValues).toBe(0);
    expect(calls.listSoulPersona).toBe(0);
    expect(calls.writeSoulSnapshot).toBe(0);
  });

  it("state 独在 → 状态行逐字；soulMood 在位 → 心境行取代绝对档位句，意图子句保留", async () => {
    const { store } = probeStore();
    const stateOnly = await buildSoulPrefix(store, TENANT, undefined, {
      state: { valence: -0.4, arousal: 0.6, topValue: "根因" },
    });
    expect(stateOnly).toContain("有点受阻，心里偏紧");
    expect(stateOnly).toContain("眼下最想推进的是根因");

    const withMood = await buildSoulPrefix(store, TENANT, undefined, {
      state: { valence: 0.6, arousal: 0.5, topValue: "定案" },
      soulMood: {
        valence: 0.1,
        arousal: 0.35,
        baselineValence: 0.05,
        baselineArousal: 0.2,
        updatedAt: "2026-11-05T05:00:00.000Z",
        sampleCount: 40,
      },
    });
    expect(withMood).toContain("近期心境");
    expect(withMood).not.toContain("此刻心里"); // 两套情绪自述不许并列
    expect(withMood).toContain("眼下最想推进的是定案");
  });

  it("不写 soul_snapshots：渲染零写入（快照落账已退役）", async () => {
    const { store, calls } = probeStore(SLOT_FIXTURE, PERSONA_FIXTURE);
    await buildSoulPrefix(store, TENANT, undefined, {
      moodTier: { tier: "positive", sampleCount: 9 },
      state: { valence: 0.8, arousal: 0.2, topValue: "定案" },
    });
    expect(calls.writeSoulSnapshot).toBe(0);
  });

  it("computeSoulVersion / isDanglingTail 仍可用（生产有消费方）", () => {
    const slots = [{ slot: "identity", content: "我是测试主体。" }];
    const v = computeSoulVersion(slots, []);
    expect(v).toBeTruthy();
    expect(computeSoulVersion(slots, [], "strained")).not.toBe(v);
    expect(isDanglingTail("一句话，")).toBe(true);
    expect(isDanglingTail("一句话。")).toBe(false);
  });
});
