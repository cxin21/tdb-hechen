import { describe, it, expect } from "vitest";
import { buildEmbeddingKey } from "./fact-key.js";

/**
 * W1（issue #134）：事实键双写——embedding 输入 = turn 原文 + 事实短语拼接。
 * 原文仍是命中载荷（record.content 不变），本函数只负责「键文本」。
 * 契约（逐片 TDD 累积）：
 *  - 无事实 / 开关关 → 逐位返回原文（缺省零行为变化）
 *  - 有事实 → 原文 + 分隔符 + 事实串（顺序保持）
 *  - 空白事实丢弃、重复事实去重（抽取噪声防御，保留首见）
 */
describe("buildEmbeddingKey", () => {
  const turn = "[2023-05-21 10:00] user: 我的 Instagram 粉丝已经涨到 1300 了";

  it("无事实时逐位返回原文", () => {
    expect(buildEmbeddingKey(turn, [])).toBe(turn);
    expect(buildEmbeddingKey(turn, undefined)).toBe(turn);
  });

  it("有事实时原文 + 分隔符 + 事实串", () => {
    const key = buildEmbeddingKey(turn, ["粉丝数 1300", "Instagram"]);
    expect(key).toBe(turn + " | 粉丝数 1300 | Instagram");
  });

  it("空白事实丢弃、重复事实去重（保留首见顺序）", () => {
    const key = buildEmbeddingKey(turn, ["粉丝数 1300", "  ", "Instagram", "粉丝数 1300", ""]);
    expect(key).toBe(turn + " | 粉丝数 1300 | Instagram");
  });

  it("全部事实无效 → 逐位返回原文", () => {
    expect(buildEmbeddingKey(turn, ["  ", ""])).toBe(turn);
  });

  it("事实预算按整条截断（不切断短语）；maxFactChars=0 → 关闭拼接", () => {
    expect(buildEmbeddingKey(turn, ["12345", "67890"], { maxFactChars: 10 })).toBe(turn + " | 12345");
    expect(buildEmbeddingKey(turn, ["12345"], { maxFactChars: 0 })).toBe(turn);
  });
});