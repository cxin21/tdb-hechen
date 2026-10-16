/**
 * #46（L1 runner 超时取证层）· scene-extractor LLM runner 证据行。
 *
 * 背景：生产日志 `extract() LLM runner failed after 300007ms: aborted due to timeout`
 * 唯一源=scene-extractor.ts extract() Phase 4（runner.run 超时抛出路径）。既有证据
 * （prompt 字符数/timeoutMs/runner 耗时）全在 debug 级，生产 INFO 不可见，无法归因
 * 「批次大小×吞吐×服务端容量」。本合同钉死取证层：
 * - 成功与失败双路径各落一行 INFO 结构化证据：
 *   `extract() runner evidence: outcome=ok|failed memories=N promptChars=X timeoutMs=Y runnerElapsedMs=Z`
 * - 失败路径 runnerElapsedMs 可得（runnerStartMs 提升至 try 外）；
 * - 既有 error 行 `LLM runner failed after ...`（:310 模板）逐字保留（日志 grep 兼容）；
 * - 零行为变更：返回值不变、不新增配置（观测性，非行为翻转）。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SceneExtractor } from "./scene-extractor.js";
import { syncSceneIndex } from "./scene-index.js";
import type { LLMRunner, Logger } from "../types.js";

const dirs: string[] = [];

function makeDataDir(): string {
  const dataDir = mkdtempSync(join(tmpdir(), "scene-timing-"));
  dirs.push(dataDir);
  mkdirSync(join(dataDir, "scene_blocks"), { recursive: true });
  return dataDir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const MEMORY = [{ content: "取证层测试记忆", created_at: "2026-10-17T00:00:00.000Z", id: "r1" }];

function makeExtractor(dataDir: string, runner: LLMRunner, info: string[], errors: string[]): SceneExtractor {
  const logger = {
    info: (msg: string) => info.push(msg),
    error: (msg: string) => errors.push(msg),
    warn: (msg: string) => undefined,
    debug: (msg: string) => undefined,
  } as unknown as Logger;
  return new SceneExtractor({
    dataDir,
    config: {},
    maxScenes: 15,
    timeoutMs: 300_000,
    logger,
    llmRunner: runner,
  });
}

describe("#46 · scene-extractor runner 证据行（INFO 结构化，成败双路径）", () => {
  it("成功路径：单行 evidence（outcome=ok）含 memories/promptChars/timeoutMs/runnerElapsedMs", async () => {
    const dataDir = makeDataDir();
    await syncSceneIndex(dataDir);
    const info: string[] = [];
    const errors: string[] = [];
    const runner: LLMRunner = {
      run: async () => "",
    } as unknown as LLMRunner;
    const ex = makeExtractor(dataDir, runner, info, errors);

    const res = await ex.extract(MEMORY);
    expect(res.success).toBe(true);

    const lines = info.filter((l) => l.includes("runner evidence:"));
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("outcome=ok");
    expect(lines[0]).toContain("memories=1");
    expect(lines[0]).toMatch(/promptChars=\d+/);
    expect(lines[0]).toContain("timeoutMs=300000");
    expect(lines[0]).toMatch(/runnerElapsedMs=\d+/);
  });

  it("失败路径：evidence（outcome=failed）含 runnerElapsedMs；既有 error 行逐字保留", async () => {
    const dataDir = makeDataDir();
    await syncSceneIndex(dataDir);
    const info: string[] = [];
    const errors: string[] = [];
    const runner: LLMRunner = {
      run: async () => {
        throw new Error("The operation was aborted due to timeout");
      },
    } as unknown as LLMRunner;
    const ex = makeExtractor(dataDir, runner, info, errors);

    const res = await ex.extract(MEMORY);
    expect(res.success).toBe(false);
    expect(res.error).toContain("aborted due to timeout");

    // 取证层：失败路径同样有结构化证据行（runnerStartMs 在 try 外可得）
    const lines = info.filter((l) => l.includes("runner evidence:"));
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("outcome=failed");
    expect(lines[0]).toContain("memories=1");
    expect(lines[0]).toContain("timeoutMs=300000");
    expect(lines[0]).toMatch(/runnerElapsedMs=\d+/);

    // 日志 grep 兼容：既有 error 模板逐字保留（#46 票面依赖该行取证）
    expect(errors.some((l) => l.includes("LLM runner failed after") && l.includes("aborted due to timeout"))).toBe(true);
  });
});
