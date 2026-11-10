/**
 * P0-3（v4 抽取契约）：人格改写系统提示词必须写明三条禁抽，并且不能让模型把它读成
 * 「assistant 说的话一律不算」——可核对事实仍要抽，且每条事实要能指回具体消息。
 *
 * 这些断言直接盯提示词文本：提示词就是这一层的契约，句子被删掉等于契约失效，
 * 单测只能证明文本在位、不能证明模型照做（生效与否见 P2 的事实一致性评测）。
 */
import { describe, expect, it } from "vitest";

import { buildSoulRewritePrompt, SOUL_REWRITE_SYSTEM_PROMPT } from "../worker.js";

describe("P0-3 人格改写提示词 × 禁抽清单", () => {
  it("三条禁抽各自成条：模糊性格描述 / 寒暄与情绪附和 / 自身能力的元叙述", () => {
    expect(SOUL_REWRITE_SYSTEM_PROMPT).toContain("禁止抽取");
    expect(SOUL_REWRITE_SYSTEM_PROMPT).toContain("模糊性格描述");
    expect(SOUL_REWRITE_SYSTEM_PROMPT).toContain("寒暄与情绪附和");
    expect(SOUL_REWRITE_SYSTEM_PROMPT).toContain("自身能力的元叙述");
  });

  it("每条禁抽都带反例，模型才知道边界在哪", () => {
    // 模糊性格描述（A1 事故那一类：把即时评价/推测当长期人格）
    expect(SOUL_REWRITE_SYSTEM_PROMPT).toContain("你看起来很热情");
    expect(SOUL_REWRITE_SYSTEM_PROMPT).toContain("这听起来很有压力");
    // 寒暄与情绪附和
    expect(SOUL_REWRITE_SYSTEM_PROMPT).toContain("好的");
    expect(SOUL_REWRITE_SYSTEM_PROMPT).toContain("收到");
    expect(SOUL_REWRITE_SYSTEM_PROMPT).toContain("这个问题问得好");
    // 关于自身能力的元叙述
    expect(SOUL_REWRITE_SYSTEM_PROMPT).toContain("我是一个由某某驱动的模型");
    expect(SOUL_REWRITE_SYSTEM_PROMPT).toContain("我可以帮你做");
  });

  it("明确「可核对事实仍要抽」，不许读成「assistant 说的话一律不算」", () => {
    expect(SOUL_REWRITE_SYSTEM_PROMPT).toContain("可核对事实仍要抽");
    expect(SOUL_REWRITE_SYSTEM_PROMPT).toContain("我把它改成 Arco 组件库了");
    expect(SOUL_REWRITE_SYSTEM_PROMPT).toContain("这行代码在 a.ts:42");
    expect(SOUL_REWRITE_SYSTEM_PROMPT).toContain("不许因为出自我的口就当成噪声");
  });

  it("要求事实能指回某条具体消息（P1-1 合并与 P2 评测的前提）", () => {
    expect(SOUL_REWRITE_SYSTEM_PROMPT).toContain("必须能指回某条具体消息");
    expect(SOUL_REWRITE_SYSTEM_PROMPT).toContain("能在该条消息原文里找到这句话");
  });

  it("保留「先看已有条目再决定」的现有措辞", () => {
    expect(SOUL_REWRITE_SYSTEM_PROMPT).toContain("先看「已有条目」再决定写哪层");
  });

  it("不引用外部项目名，也不搬英文原文", () => {
    for (const name of ["Mem0", "mem0", "MemGPT", "Letta", "Zep", "Graphiti"]) {
      expect(SOUL_REWRITE_SYSTEM_PROMPT).not.toContain(name);
    }
    // 禁抽清单本身就三条中文，没有夹带英文小标题。
    expect(SOUL_REWRITE_SYSTEM_PROMPT).not.toMatch(/vague assistant|generic assistant|meta-commentary/i);
  });

  it("user 提示词仍先给「已有条目」，与系统提示词第 13 条呼应", () => {
    const prompt = buildSoulRewritePrompt({
      existing: [{ layer: "identity", text: "我宁可慢一点把账算清。" }],
      records: [],
      maxCandidates: 3,
    });
    expect(prompt).toContain("已有条目（不要重复，可以提出更准确的改写）");
    expect(prompt).toContain("- [identity] 我宁可慢一点把账算清。");
    // 没有条目时也保留这个区块，模型不会因为空输入改走别的写法。
    expect(
      buildSoulRewritePrompt({ existing: [], records: [], maxCandidates: 1 }),
    ).toContain("已有条目（不要重复，可以提出更准确的改写）");
  });
});
