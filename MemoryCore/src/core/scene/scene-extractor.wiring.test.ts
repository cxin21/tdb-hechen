/**
 * R4（2026-10-06 实施轮）SceneExtractor 接线与 no-progress 契约测试（RED 先行）。
 *
 * 1) 接线：opts.reasoningEffort → runner.run 逐调用透传（config-first 关思考，
 *    复用 llm-runner.ts:383-387 既有 providerOptions.openaiCompatible.reasoningEffort 通道）；
 * 2) 未配置时 run 参数不带 reasoningEffort 字段（保持端点默认，零行为变更）；
 * 3) UR-10（修订）：输入非空 + 零文件变更 ⇒ noOpIntegrated=true 且 emptyExtraction=false（不毒批）
 *    （旧实现仅「前后索引皆空」才判空，存量场景下的空跑被误计成功并推进 checkpoint）；
 * 4) UR-8：空场景目录时 user prompt 注入 0 值容量头（当前场景总数：0 / max）。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SceneExtractor } from "./scene-extractor.js";
import { syncSceneIndex } from "./scene-index.js";
import type { LLMRunner } from "../types.js";

const dirs: string[] = [];

function makeDataDir(withSceneBlock = false): string {
  const dataDir = mkdtempSync(join(tmpdir(), "r4-scene-"));
  dirs.push(dataDir);
  mkdirSync(join(dataDir, "scene_blocks"), { recursive: true });
  if (withSceneBlock) {
    writeFileSync(
      join(dataDir, "scene_blocks", "A.md"),
      [
        "-----META-START-----",
        "created: 2026-01-01T00:00:00.000Z",
        "updated: 2026-01-01T00:00:00.000Z",
        "summary: existing scene for wiring test",
        "heat: 1",
        "-----META-END-----",
        "",
        "## 核心叙事",
        "",
        "既有场景正文，用于验证零变更检测。",
        "",
      ].join("\n"),
      "utf-8",
    );
  }
  return dataDir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function captureRunner(captured: Array<Record<string, unknown>>): LLMRunner {
  return {
    run: async (params: Record<string, unknown>) => {
      captured.push(params);
      return "";
    },
  } as unknown as LLMRunner;
}

const MEMORY = [{ content: "新增记忆内容", created_at: "2026-10-06T00:00:00.000Z", id: "r1" }];

describe("R4 SceneExtractor 接线与 no-progress 契约", () => {
  it("opts.reasoningEffort 透传到 runner.run（关思考 config-first 接线）", async () => {
    const dataDir = makeDataDir(true);
    await syncSceneIndex(dataDir);
    const captured: Array<Record<string, unknown>> = [];
    const ex = new SceneExtractor({
      dataDir,
      config: {},
      maxScenes: 15,
      reasoningEffort: "none",
      llmRunner: captureRunner(captured),
    });
    const res = await ex.extract(MEMORY);
    expect(res.success).toBe(true);
    expect(captured.length).toBe(1);
    expect(captured[0]!.reasoningEffort).toBe("none");
  });

  it("未配置 reasoningEffort 时 run 参数不带该字段（端点默认）", async () => {
    const dataDir = makeDataDir(false);
    await syncSceneIndex(dataDir);
    const captured: Array<Record<string, unknown>> = [];
    const ex = new SceneExtractor({
      dataDir,
      config: {},
      maxScenes: 15,
      llmRunner: captureRunner(captured),
    });
    await ex.extract(MEMORY);
    expect(captured[0]!.reasoningEffort).toBeUndefined();
  });

  it("UR-10（修订）输入非空且零文件变更 ⇒ noOpIntegrated=true 且 emptyExtraction=false（不毒批）", async () => {
    const dataDir = makeDataDir(true);
    await syncSceneIndex(dataDir); // 建 scene_index → preExtractIndex.size===1
    const captured: Array<Record<string, unknown>> = [];
    const ex = new SceneExtractor({
      dataDir,
      config: {},
      maxScenes: 15,
      llmRunner: captureRunner(captured),
    });
    const res = await ex.extract(MEMORY);
    expect(res.success).toBe(true);
    expect(res.noOpIntegrated).toBe(true);
    expect(res.emptyExtraction).toBe(false);
  });

  it("UR-8 空场景目录时 user prompt 容量头显示 0 / max", async () => {
    const dataDir = makeDataDir(false);
    await syncSceneIndex(dataDir);
    const captured: Array<Record<string, unknown>> = [];
    const ex = new SceneExtractor({
      dataDir,
      config: {},
      maxScenes: 15,
      llmRunner: captureRunner(captured),
    });
    await ex.extract(MEMORY);
    const prompt = String(captured[0]!.prompt ?? "");
    expect(prompt).toContain("当前场景总数：0 / 15");
  });
});
