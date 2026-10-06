import { describe, it, expect } from "vitest";
import { enrichSoulFields } from "./l1-extractor.js";
import type { ExtractedMemory } from "./l1-writer.js";
import type { LLMRunner } from "../types.js";

/**
 * R3（l1-enrich 字段回填）调用方式 + 提示词契约测试（2026-10-06 实施轮）。
 *
 * 依据（真实数据）：
 *  - 关思考：R1 v21 十组 A/B 质量持平、均时延 4923→3354ms（-32%）；R2 v22 三臂 -44%；
 *    R3 timeout 仅 30s（比 R1/R2 的 180s 紧得多），思考开启抬升超时面 → 必改项。
 *  - M1/M2：模型回字符串 index（"0"）时 byIndex.get(数字) 永 miss → 静默丢弃整行。
 *  - M3：消费侧零 clamp/零 ISO 校验，越界值与幻觉时间可直插入库（对照 R1 clampNum）。
 *  - M4：中性缺省须与 l1-writer.ts:322-324 合标层逐字对齐（valence=0/arousal=0/significance=0.5），
 *    终值零漂移。
 *  - M5/S1：收口句常量垫底；规则回填后重过滤，全填行不再白跑 LLM。
 */

interface Captured {
  prompt?: string;
  systemPrompt?: string;
  taskId?: string;
  timeoutMs?: number;
  reasoningEffort?: string;
}

function mem(content: string, over: Partial<ExtractedMemory> = {}): ExtractedMemory {
  return {
    content,
    type: "episodic",
    priority: 50,
    source_message_ids: [],
    metadata: {},
    scene_name: "测试情境",
    ...over,
  } as ExtractedMemory;
}

/** 无时间锚/情感词/重要性词 → 确定性规则回填不掉关键字段（仅 certainty 恒补 observed）。 */
const NEUTRAL = "系统状态巡检确认各项指标正常。";
const NEUTRAL2 = "构建流水线的产物清单已核对完毕。";

function makeRunner(ret: string) {
  const calls: Captured[] = [];
  const llmRunner = {
    run: async (p: Captured) => {
      calls.push(p);
      return ret;
    },
  } as unknown as LLMRunner;
  return { llmRunner, calls };
}

describe("R3 关思考接线", () => {
  it("主调 llmRunner.run 收到 reasoningEffort=none（对齐 R1 :659 / R2 先例）", async () => {
    const { llmRunner, calls } = makeRunner("[]");
    await enrichSoulFields([mem(NEUTRAL)], { config: {}, llmRunner });
    expect(calls).toHaveLength(1);
    expect(calls[0].reasoningEffort).toBe("none");
  });

  it("taskId / timeoutMs 保持既有语义（回归）", async () => {
    const { llmRunner, calls } = makeRunner("[]");
    await enrichSoulFields([mem(NEUTRAL)], { config: {}, llmRunner });
    expect(calls[0].taskId).toBe("l1-enrich");
    expect(calls[0].timeoutMs).toBe(30_000);
  });
});

describe("R3 提示词契约（M1/M4/M5/S3/S4）", () => {
  it("system prompt 含 index 数字契约+编号不连续说明+中性缺省+收口句", async () => {
    const { llmRunner, calls } = makeRunner("[]");
    await enrichSoulFields([mem(NEUTRAL)], { config: {}, llmRunner });
    const sys = calls[0].systemPrompt ?? "";
    expect(sys).toContain("记忆字段补全器");
    expect(sys).toContain("编号可能不连续"); // M1：只送缺字段行 → 编号天然不连续
    expect(sys).toContain("不是字符串"); // M1：index 数字类型契约
    expect(sys).toContain("0.5"); // M4：significance 中性缺省（对齐 writer 合标层）
    expect(sys).toContain("只输出一个JSON数组"); // M5：收口句（单源常量）
    expect(sys).toContain("observed"); // S3：certainty 两句判定
    expect(sys).toContain("2026-10-05T14:30:00"); // S4：ISO 示例
  });
});

describe("R3 规则回填后重过滤（S1）", () => {
  it("规则已全填的行不再发起 LLM 调用（零浪费）", async () => {
    const { llmRunner, calls } = makeRunner("[]");
    // 时间锚(昨天)+情感(开心)+重要性(关键/决定) → 规则可回填全部 5 字段
    await enrichSoulFields([mem("昨天完成了关键决定，非常开心。")], { config: {}, llmRunner });
    expect(calls).toHaveLength(0);
  });

  it("只把仍缺字段的行送入 prompt，且编号保持原序（可能不连续）", async () => {
    const { llmRunner, calls } = makeRunner("[]");
    const filled = mem("昨天完成了关键决定，非常开心。"); // 行 0：规则全填 → 不进 prompt
    const open = mem(NEUTRAL2); // 行 1：规则填不齐 → 仍缺
    await enrichSoulFields([filled, open], { config: {}, llmRunner });
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toContain("1. ");
    expect(calls[0].prompt).not.toContain("0. ");
  });
});

describe("R3 消费侧加固（M2/M3）", () => {
  it("模型回字符串 index 仍能按数字归一回填", async () => {
    const { llmRunner } = makeRunner(
      JSON.stringify([{ index: "0", occurred_at: "", certainty: "observed", valence: 0.1, arousal: 0.2, significance: 0.3 }]),
    );
    const m = mem(NEUTRAL);
    await enrichSoulFields([m], { config: {}, llmRunner });
    expect(m.valence).toBe(0.1);
    expect(m.significance).toBe(0.3);
  });

  it("越界数值入库前 clamp 到各自范围（对齐 R1 clampNum）", async () => {
    const { llmRunner } = makeRunner(
      JSON.stringify([{ index: 0, occurred_at: "", certainty: "observed", valence: 3.7, arousal: -0.5, significance: 9 }]),
    );
    const m = mem(NEUTRAL);
    await enrichSoulFields([m], { config: {}, llmRunner });
    expect(m.valence).toBe(1);
    expect(m.arousal).toBe(0);
    expect(m.significance).toBe(1);
  });

  it("非 ISO 时间不回填（宁缺勿错，终值交由 writer 合标层兜底）", async () => {
    const { llmRunner } = makeRunner(
      JSON.stringify([{ index: 0, occurred_at: "昨天下午", certainty: "inferred", valence: 0, arousal: 0, significance: 0.5 }]),
    );
    const m = mem(NEUTRAL);
    await enrichSoulFields([m], { config: {}, llmRunner });
    expect(m.occurred_at).toBeFalsy();
  });

  it("已填字段不被 LLM 覆盖（只填空，回归）", async () => {
    const { llmRunner } = makeRunner(
      JSON.stringify([{ index: 0, occurred_at: "", certainty: "inferred", valence: 0.9, arousal: 0.9, significance: 0.9 }]),
    );
    const m = mem(NEUTRAL, { valence: 0.4 });
    await enrichSoulFields([m], { config: {}, llmRunner });
    expect(m.valence).toBe(0.4);
  });
});
