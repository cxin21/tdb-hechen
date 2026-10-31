/**
 * #156（P0）：L1 提取提示词的「单一来源」契约——把 assistant 桶 turnCov 66.7% 的假根因钉死。
 *
 * 生产症状：assistant 轮次的记忆抽不出来（#138 只能靠 routing=assistantRecall 权宜兜底）。
 * 真因不是「agent 通道缺失」，而是同一份 system prompt 里两条规则互相否定：
 *   - 「### 不应该提取的内容」把「AI助手自身的行为或输出」列进禁抽清单；
 *   - gated 的 AGENT_ACT_BLOCK 又要求「以第一人称提取为独立记忆，type=persona/instruction」。
 * 模型面对矛盾信号时保守=不抽，于是 agent 自述行为永远进不了 L1，下游巩固/结论层空转。
 *
 * 修法（单一来源）：禁抽清单只留「无信息量的一次性寒暄/确认/空泛回复」；
 * 「agent 自述行为必须抽」只在 AGENT_ACT_BLOCK 一处定义，且仍受 selfIdentityEnabled 门控。
 * 本文件锁三件事：
 *  1) chat base 不再出现旧禁令，负向清单仍保留寒暄口径（不是简单删条了事）；
 *  2) 正向规则（第一人称/agent 行为事实）全 prompt 恰好出现一次，只在开关开时出现；
 *  3) 开关开时两个方向共存不互斥，code 版（work_*）逐位不受影响。
 */
import { describe, expect, it } from "vitest";
import {
  EXTRACT_MEMORIES_SYSTEM_PROMPT,
  EXTRACT_WORK_MEMORIES_SYSTEM_PROMPT,
  getExtractMemoriesSystemPrompt,
} from "./l1-extraction.js";

/** 旧禁令原文（与 AGENT_ACT_BLOCK 正面矛盾的那一条）。 */
const OLD_CONTRADICTION = "AI助手自身的行为或输出";

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("#156 提取提示词单源化（禁抽清单 vs agent 行为事实）", () => {
  it("chat base 不再把「助手自身的行为或输出」列为不提取", () => {
    expect(EXTRACT_MEMORIES_SYSTEM_PROMPT).not.toContain(OLD_CONTRADICTION);
    // 负向清单仍存在（不是把整条删掉了事），只是口径收窄到「无信息量回复」
    expect(EXTRACT_MEMORIES_SYSTEM_PROMPT).toContain("### 不应该提取的内容");
    expect(EXTRACT_MEMORIES_SYSTEM_PROMPT).toContain("寒暄");
  });

  it("正向规则只在 gated 块里定义一次（开关关=base 不含，开关开=恰好一处）", () => {
    const off = getExtractMemoriesSystemPrompt("chat");
    const on = getExtractMemoriesSystemPrompt("chat", { selfIdentityEnabled: true });
    // 关：base 不得出现 agent 行为事实指令（否则 selfIdentity 门形同虚设）
    expect(off).not.toContain("agent 行为事实");
    expect(countOf(off, "第一人称")).toBe(0);
    // 开：恰好一处——防「靠堆提示词修问题」把同一条规则写两遍
    expect(countOf(on, "第一人称")).toBe(1);
    // 标题级定义唯一（块内正文还会自然提到这个词，故按标题锚计数）
    expect(countOf(on, "## agent 行为事实")).toBe(1);
  });

  it("开关开时两个方向共存：agent 自述行为可抽 + 一次性寒暄仍不抽", () => {
    const on = getExtractMemoriesSystemPrompt("chat", { selfIdentityEnabled: true });
    expect(on).toContain("agent 行为事实");
    expect(on).toContain("寒暄");
    expect(on).not.toContain(OLD_CONTRADICTION);
    expect(on).toContain("persona");
    expect(on).toContain("instruction");
  });

  it("code 版（work_* 四类）逐位不受影响", () => {
    const code = getExtractMemoriesSystemPrompt("code", { selfIdentityEnabled: true });
    expect(code).not.toContain("agent 行为事实");
    expect(code).toContain(EXTRACT_WORK_MEMORIES_SYSTEM_PROMPT);
    // code 版自己的 skip 口径（未被采纳的 AI 建议/临时草稿）与 agent 行为事实不冲突
    expect(code).toContain("未被采纳");
  });
});
