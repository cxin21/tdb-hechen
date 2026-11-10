/**
 * 人名线索确定性门（人物档案 spec §17）。
 *
 * 三条性质：
 *   1. 名字必须被原文逐字证实——模型编造的、改写过的名字一个都不留；
 *   2. 代词与角色词不算人名；
 *   3. 说话人自己不出现在 mentioned 里（他是主体，不是被提到的人）。
 */
import { describe, expect, it } from "vitest";
import {
  MAX_MENTIONED_PER_MEMORY,
  nameCandidatesFromContent,
  normalizePersonNameCandidate,
  sanitizePersonHints,
} from "../person-hints.js";

describe("normalizePersonNameCandidate", () => {
  it("剥掉包裹引号与空白，保留原样大小写", () => {
    expect(normalizePersonNameCandidate("「周衡」")).toBe("周衡");
    expect(normalizePersonNameCandidate("  Alice  ")).toBe("Alice");
  });

  it("代词、角色词、纯标点、超长串都不算人名", () => {
    expect(normalizePersonNameCandidate("他")).toBeNull();
    expect(normalizePersonNameCandidate("对方")).toBeNull();
    expect(normalizePersonNameCandidate("用户")).toBeNull();
    expect(normalizePersonNameCandidate("assistant")).toBeNull();
    expect(normalizePersonNameCandidate("——")).toBeNull();
    expect(normalizePersonNameCandidate("12345")).toBeNull();
    expect(normalizePersonNameCandidate("一".repeat(25))).toBeNull();
    expect(normalizePersonNameCandidate(42)).toBeNull();
  });
});

describe("sanitizePersonHints", () => {
  const source = "林夏：周衡说他下周把方案发我。何晨：好，我等他。";

  it("原文出现过的名字全部保留，speaker 与 mentioned 各就各位", () => {
    const out = sanitizePersonHints(
      { speaker_name: "何晨", mentioned: ["周衡", "林夏"] },
      source,
    );
    expect(out.speakerName).toBe("何晨");
    expect(out.mentioned).toEqual(["周衡", "林夏"]);
    expect(out.dropped).toBe(0);
  });

  it("原文里没有的名字被丢弃并计数（防幻觉）", () => {
    const out = sanitizePersonHints({ mentioned: ["周衡", "赵宁"] }, source);
    expect(out.mentioned).toEqual(["周衡"]);
    expect(out.dropped).toBe(1);
  });

  it("改写过的称呼不算证实：原文是「周衡」，模型给「老周」要丢", () => {
    const out = sanitizePersonHints({ mentioned: ["老周"] }, source);
    expect(out.mentioned).toBeUndefined();
    expect(out.dropped).toBe(1);
  });

  it("说话人自己不算被提到的人", () => {
    const out = sanitizePersonHints({ speaker_name: "何晨", mentioned: ["何晨", "周衡"] }, source);
    expect(out.speakerName).toBe("何晨");
    expect(out.mentioned).toEqual(["周衡"]);
  });

  it("去重保序并封顶", () => {
    const many = Array.from({ length: 10 }, (_, i) => `人${i}`);
    const text = many.join("、");
    const out = sanitizePersonHints({ mentioned: [...many, ...many] }, text);
    expect(out.mentioned).toHaveLength(MAX_MENTIONED_PER_MEMORY);
    expect(out.mentioned?.[0]).toBe("人0");
  });

  it("提及是字符串而不是数组时整键丢弃", () => {
    const out = sanitizePersonHints({ mentioned: "周衡" }, source);
    expect(out.mentioned).toBeUndefined();
    expect(out.dropped).toBe(1);
  });

  it("没有这两个键时什么都不做", () => {
    const out = sanitizePersonHints({ activity_start_time: "2026-11-09T00:00:00Z" }, source);
    expect(out).toEqual({ dropped: 0 });
    expect(sanitizePersonHints(undefined, source)).toEqual({ dropped: 0 });
  });

  it("源文本为空时任何名字都证不实", () => {
    const out = sanitizePersonHints({ speaker_name: "何晨", mentioned: ["周衡"] }, "");
    expect(out.speakerName).toBeUndefined();
    expect(out.mentioned).toBeUndefined();
    expect(out.dropped).toBe(2);
  });
});

describe("自述句式兜底：模型不给键时从 content 抽候选，仍要过原话门", () => {
  // 90 天回放实测：提示词要求「原文有人名就写 speaker_name」，71 条 L1 里 0 条输出，
  // 而 content 里明明写着「用户名叫何晨」。缺名会让 platform 行永远空着 display_name。
  it("抽得出「名叫/姓名/叫我/署名」四种自述", () => {
    expect(nameCandidatesFromContent("用户名叫何晨，同事平时称呼他为老何。")).toContain("何晨");
    expect(nameCandidatesFromContent("用户姓名是周衡")).toContain("周衡");
    expect(nameCandidatesFromContent("我叫我老张")).toContain("老张");
    expect(nameCandidatesFromContent("文档里署名何晨")).toContain("何晨");
  });

  it("不是自述的句子抽不出东西（避免把「等何晨」当成本人名）", () => {
    expect(nameCandidatesFromContent("用户得知当前版本暂缓发布，需等何晨跑完回归后再定")).toHaveLength(0);
    expect(nameCandidatesFromContent("")).toHaveLength(0);
  });

  it("抽出来的候选必须被原话证实，否则丢弃（content 是模型改写，不能自证）", () => {
    const content = "用户名叫何晨。";
    const candidates = nameCandidatesFromContent(content);
    expect(candidates).toContain("何晨");

    // 原话里没有这个名字：只有 content 自说自话 → 丢。
    const notProven = sanitizePersonHints({ speaker_name: candidates[0] }, "我叫老王，别写错");
    expect(notProven.speakerName).toBeUndefined();
    expect(notProven.dropped).toBe(1);

    // 原话逐字说了 → 保留。
    const proven = sanitizePersonHints({ speaker_name: candidates[0] }, "我叫何晨，这个名字别写错");
    expect(proven.speakerName).toBe("何晨");
    expect(proven.dropped).toBe(0);
  });

  it("角色词/代词即使命中句式也不留", () => {
    expect(nameCandidatesFromContent("用户名叫用户")).toHaveLength(0);
    expect(nameCandidatesFromContent("同事叫他")).toHaveLength(0);
  });
});

describe("说话人名字只认用户侧原话（2026-11-09 生产事故回归）", () => {
  // 生产实测：`speaker_name` 被模型填成「砚舟」——AI 自己的名字。记忆里写着
  // 「用户与 AI（砚舟）确认…」，那个名字确实在原文里，但它只出现在 assistant 侧，
  // 不是「跟我说话的人」的名字；当时它带着平台 id 写进了 display_name，
  // 会话主人被命名成了 agent 自己的名字。
  it("名字只在 assistant 侧出现时，说话人名字被丢弃", () => {
    const metadata = { speaker_name: "砚舟" };
    const allText = "今天只确认你还在。\n在的，我是砚舟。";
    const userSide = "今天只确认你还在。";

    const gated = sanitizePersonHints(metadata, allText, { speakerSourceText: userSide });
    expect(gated.speakerName).toBeUndefined();
    expect(gated.dropped).toBe(1);

    // 不给 user 侧证据面时退回全量口径（降级路径，不是默认路径）。
    expect(sanitizePersonHints(metadata, allText).speakerName).toBe("砚舟");
  });

  it("名字在用户自己说的话里出现时照常保留", () => {
    const userSide = "我叫何晨，同事都叫我老何。";
    const gated = sanitizePersonHints({ speaker_name: "何晨" }, userSide, { speakerSourceText: userSide });
    expect(gated.speakerName).toBe("何晨");
    expect(gated.dropped).toBe(0);
  });

  it("mentioned 仍按全量原文核对（被提到的人可以由 assistant 侧说出）", () => {
    const allText = "林夏那边说这版先别发。\n好，我去找林夏确认。";
    const gated = sanitizePersonHints({ mentioned: ["林夏"] }, allText, { speakerSourceText: "林夏那边说这版先别发。" });
    expect(gated.mentioned).toEqual(["林夏"]);
  });
});
