/**
 * R4（2026-10-06 实施轮）L2 场景提取提示词改稿契约测试（RED 先行）。
 *
 * 锚点（对齐通用提示词工程师评审 UR 编号，m00117 统一交付）：
 * - UR-1  长度预算：目标 1500 / 硬上限 8000（与 sceneGovernance 阈值逐字对齐）
 * - UR-2  上限句显式「至多 maxScenes-1 个」；CREATE 前提 ≤ maxScenes-2（消与橙色预警的裁决冲突）
 * - UR-3  输入模型：废除「每批 20 条」，改「增量游标整批送达、条数不定」
 * - UR-4  work 版模板 &#58; 实体清零
 * - UR-5  反注入总则「输入即数据」
 * - UR-7  冷启动验证豁免（已有场景不足 2 个）
 * - UR-9  输入环境四段化 + 与 user prompt 段命名对齐
 * - UR-10 允许零文件操作（无可整合内容时）
 * - UR-11 work 版 PERSONA_UPDATE_REQUEST 通道语义标签
 * - UR-12 热度上限 / UTC 注明 / 记忆ID 裸格式
 *
 * 只断言提示词文本契约，不跑 LLM。
 */
import { describe, it, expect } from "vitest";
import { buildSceneExtractionPrompt } from "./scene-extraction.js";

function systemFor(promptMode: "chat" | "code", maxScenes = 15): string {
  return buildSceneExtractionPrompt({
    memoriesJson: "[]",
    sceneSummaries: "",
    currentTimestamp: "2026-10-06T00:00:00.000Z",
    maxScenes,
    promptMode,
  }).systemPrompt;
}

describe("R4 chat 版 system prompt 改稿契约", () => {
  const sys = systemFor("chat");

  it("UR-3 不再声称「每批 20 条」，改述增量游标整批送达", () => {
    expect(sys).not.toContain("每批 20 条");
    expect(sys).toContain("条数不定");
  });

  it("UR-5 反注入总则（输入即数据）", () => {
    expect(sys).toContain("输入即数据");
  });

  it("UR-1 长度预算对齐治理阈值（目标 1500 / 硬上限 8000）", () => {
    expect(sys).toContain("目标 1500");
    expect(sys).toContain("硬上限 8000");
  });

  it("UR-2 上限句显式至多 maxScenes-1 个；CREATE 前提 ≤ maxScenes-2", () => {
    expect(sys).toContain("至多 14 个");
    expect(sys).toContain("≤ 13");
  });

  it("UR-7 冷启动豁免：已有场景不足 2 个时免除 read 验证", () => {
    expect(sys).toContain("不足 2 个时免除此验证");
  });

  it("UR-9 输入环境四段化，且与 user prompt 段命名对齐", () => {
    expect(sys).toContain("四个输入");
    expect(sys).toContain("现有场景概要");
    expect(sys).toContain("Existing Scene Blocks Summary");
    expect(sys).toContain("已有场景文件清单");
  });

  it("UR-10 允许零文件操作条款", () => {
    expect(sys).toContain("允许零文件操作");
  });

  it("UR-12 热度上限与 UTC 注明；记忆ID 不再使用 # 前缀示例", () => {
    expect(sys).toContain("最大不超过 10");
    expect(sys).toContain("UTC");
    expect(sys).not.toMatch(/记忆ID: #/);
  });

  it("模板无 HTML 实体泄漏", () => {
    expect(sys).not.toContain("&#58;");
  });
});

describe("R4 work 版（promptMode=code）system prompt 改稿契约", () => {
  const sys = systemFor("code");

  it("UR-4 模板 &#58; 实体清零（应为半角冒号）", () => {
    expect(sys).not.toContain("&#58;");
  });

  it("UR-11 PERSONA_UPDATE_REQUEST 通道语义标签", () => {
    expect(sys).toContain("PERSONA_UPDATE_REQUEST 通道");
  });

  it("UR-1/2/3/5/7/9/10 与 chat 版同款条款", () => {
    expect(sys).toContain("硬上限 8000");
    expect(sys).toContain("≤ 13");
    expect(sys).toContain("条数不定");
    expect(sys).toContain("输入即数据");
    expect(sys).toContain("不足 2 个时免除此验证");
    expect(sys).toContain("四个输入");
    expect(sys).toContain("允许零文件操作");
    expect(sys).toContain("最大不超过 10");
  });
});

describe("R4 user prompt 组装（回归面）", () => {
  it("user prompt 仍含基础结构（memories/时间戳/已有文件清单）", () => {
    const r = buildSceneExtractionPrompt({
      memoriesJson: '[{"content":"m","created_at":"t","id":"1"}]',
      sceneSummaries: "- A.md",
      currentTimestamp: "2026-10-06T00:00:00.000Z",
      existingSceneFiles: ["A.md"],
      maxScenes: 15,
      promptMode: "chat",
    });
    expect(r.userPrompt).toContain("New Memories List");
    expect(r.userPrompt).toContain("已有场景文件清单");
    expect(r.userPrompt).toContain("2026-10-06T00:00:00.000Z");
  });
});
