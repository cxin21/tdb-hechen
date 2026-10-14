/**
 * P1 Task 7（worthiness importance，spec §6）：提示词门 RED 套件。
 * 契约（镜像 D-3 SENSITIVITY_BLOCK / D-4 RECURRENCE_BLOCK 先例）：
 *  - IMPORTANCE_BLOCK gated via opts.importanceEnabled；缺省关闭 = 逐位现状（prompt 字节不变）；
 *  - 开启时块追加在 gated 链尾、FINAL_FORMAT_SENTENCE 永远最后（P1-1 收口不变式）；
 *  - code 模式永不追加（chat 专属语义，同 selfIdentity/sensitivity）。
 */
import { describe, it, expect } from "vitest";
import { getExtractMemoriesSystemPrompt, FINAL_FORMAT_SENTENCE } from "./l1-extraction.js";

describe("P1-T7 IMPORTANCE_BLOCK 提示词门", () => {
  it("缺省关闭 = 逐位现状（prompt 字节不变）", () => {
    const baseline = getExtractMemoriesSystemPrompt("chat", { sensitivityEnabled: true });
    expect(getExtractMemoriesSystemPrompt("chat", { sensitivityEnabled: true })).toBe(baseline);
    expect(getExtractMemoriesSystemPrompt("chat", { sensitivityEnabled: true, importanceEnabled: false })).toBe(baseline);
    // 全关：与 legacy 无 opts 完全一致
    expect(getExtractMemoriesSystemPrompt("chat")).toBe(getExtractMemoriesSystemPrompt("chat", {}));
  });

  it("开启时包含重要度块，且 FINAL_FORMAT_SENTENCE 仍在末位（P1-1 不变式）", () => {
    const p = getExtractMemoriesSystemPrompt("chat", { importanceEnabled: true });
    expect(p).toContain("重要度标注");
    expect(p).toContain("importance_reason");
    expect(p.endsWith(FINAL_FORMAT_SENTENCE)).toBe(true);
    // 与关闭态严格多出一个块（不挤占其他 gated 块字节）
    const off = getExtractMemoriesSystemPrompt("chat", {});
    expect(p.startsWith(off.slice(0, off.length - FINAL_FORMAT_SENTENCE.length))).toBe(true);
  });

  it("code 模式永不追加（同 selfIdentity/sensitivity 口径）", () => {
    expect(getExtractMemoriesSystemPrompt("code", { importanceEnabled: true })).not.toContain("重要度标注");
  });
});
