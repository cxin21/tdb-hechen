/**
 * A3 Round7（C3）：L2 摘要的硬校验。
 *
 * 提示词只能约束、不能保证——旧实现只做 JSON.parse + content 非空，生产持久态卡
 * content 最长 4115 字、均值 1423（L3 有 300 码点门，L2 等于没有上限）。
 * 这里钉住三条硬门：正文 >1200 字直接丢弃（返回 null，不落卡）；提示词里的字数上限与
 * 代码硬门必须是同一个数字；模型自述 inferred 的摘要直接丢弃（不把推断洗成 observed）。
 */
import { describe, expect, it } from "vitest";
import { buildDurativeSummary } from "../summarizer.js";

const group = {
  subject: "定案",
  memories: [
    { id: "r1", content: "决定先做前端", type: "episodic", createdAt: "2026-10-01T00:00:00.000Z" },
    { id: "r2", content: "拍板：先做前端", type: "episodic", createdAt: "2026-10-02T00:00:00.000Z" },
  ],
  latestTs: Date.parse("2026-10-02T00:00:00.000Z"),
  earliestTs: Date.parse("2026-10-01T00:00:00.000Z"),
};

const run = (payload: unknown, logger?: { warn: (m: string) => void }) =>
  buildDurativeSummary(group as never, {
    llmRunner: { run: async () => JSON.stringify(payload) } as never,
    logger: logger as never,
  });

describe("A3 Round7：L2 摘要硬校验", () => {
  it("正文超过 1200 字直接丢弃并告警，不写进持续态", async () => {
    const warns: string[] = [];
    const dur = await run({ content: "字".repeat(1201), certainty: "observed" }, { warn: (m) => warns.push(m) });
    expect(dur).toBeNull();
    expect(warns.join("\n")).toContain("too long");
  });

  it("刚好 1200 字仍接受（边界不是随手定的）", async () => {
    const dur = await run({ content: "字".repeat(1200), certainty: "observed" });
    expect(dur).not.toBeNull();
    expect(dur!.content.length).toBe(1200);
  });

  it("模型自述 inferred 的摘要直接丢弃：推断不得冒充观测（A3 Round10 P0-1）", async () => {
    const warns: string[] = [];
    const dur = await run({ content: "先做前端这件事已经定了。", certainty: "inferred" }, { warn: (m) => warns.push(m) });
    expect(dur).toBeNull();
    expect(warns.join("\n")).toContain("declared inferred");
  });

  it("提示词里的字数上限与代码硬门一致（A3 Round10 P0-2）", async () => {
    const mod = await import("../summarizer.js");
    const src = mod.DEFAULT_PROMPT_PREFIX;
    // 提示词必须写 1200（旧的 300 与 1200 的硬门相差 4 倍，等于告诉模型一个假规则）。
    expect(src).toContain("1200 字");
  });
});
