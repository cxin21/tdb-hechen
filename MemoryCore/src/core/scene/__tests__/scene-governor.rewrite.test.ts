/**
 * R5（2026-10-12 实施轮）SceneGovernor 蒸馏调用契约测试（RED 先行）。
 *
 * R5-2 maxTokens 预算：蒸馏产出目标 ≤ maxBlockChars 字符（中文可达 5-13K tokens），
 *   governor 必须显式传 maxTokens=⌈maxBlockChars×1.6⌉——runner 缺省 4096 tokens
 *   （llm-runner.ts rawMaxTokens ?? config ?? 4096）会把大块蒸馏输出拦腰截断，
 *   且 validateDistilled 四条件（有 META/正文非空/总长合规/无坏字）恰好放行截断
 *   残块 → 静默写回残缺块并计入 distilled 成功。
 * R5-3 时间源：governOne 以运行时 ISO 时间作为 updated 的时间源传入 prompt。
 */
import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SceneGovernor } from "../scene-governor.js";
import type { SceneGovernorRunner } from "../scene-governor.js";
import { formatMeta } from "../scene-format.js";
import type { SceneBlockMeta } from "../scene-format.js";
import type { SceneGovernanceConfig } from "../../../config.js";

const META: SceneBlockMeta = {
  created: "2026-09-01T00:00:00Z",
  updated: "2026-09-02T00:00:00Z",
  summary: "原始摘要",
  heat: 7,
};
const OVERSIZED = `${formatMeta(META)}\n\n${"甲".repeat(200)}`;

function govCfg(): SceneGovernanceConfig {
  return { enabled: true, maxBlockChars: 140, distillTimeoutMs: 1000, hardCapChars: 160 };
}

async function makeFixture(): Promise<{ dataDir: string; cleanup: () => Promise<void> }> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "r5-governor-"));
  const blocksDir = path.join(dataDir, "scene_blocks");
  await mkdir(blocksDir, { recursive: true });
  await writeFile(path.join(blocksDir, "big.md"), OVERSIZED, "utf-8");
  return { dataDir, cleanup: () => rm(dataDir, { recursive: true, force: true }) };
}

describe("R5 SceneGovernor 蒸馏调用契约", () => {
  it("R5-2 runner.run 显式携带 maxTokens=⌈maxBlockChars×1.6⌉（防 4096 缺省截断残块写回）", async () => {
    const { dataDir, cleanup } = await makeFixture();
    const captured: Array<Record<string, unknown>> = [];
    const runner: SceneGovernorRunner = {
      run: vi.fn(async (p: { systemPrompt: string; prompt: string; timeoutMs?: number }) => {
        captured.push(p as Record<string, unknown>);
        return p.prompt.slice(0, 10); // 不合格产出 → 走兜底路径，不影响断言
      }),
    };
    try {
      await new SceneGovernor({ runner }).govern({ dataDir, config: govCfg() });
      expect(captured.length).toBe(1);
      expect(captured[0]!.maxTokens).toBe(Math.ceil(140 * 1.6)); // 224
    } finally {
      await cleanup();
    }
  });

  it("R5-3 蒸馏 prompt 携带运行时 ISO 当前时间（updated 字段时间源，防模型幻觉日期）", async () => {
    const { dataDir, cleanup } = await makeFixture();
    let seenPrompt = "";
    const runner: SceneGovernorRunner = {
      run: vi.fn(async (p: { systemPrompt: string; prompt: string; timeoutMs?: number }) => {
        seenPrompt = p.prompt;
        return "";
      }),
    };
    try {
      await new SceneGovernor({ runner }).govern({ dataDir, config: govCfg() });
      expect(seenPrompt).toContain("当前时间");
      expect(seenPrompt).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    } finally {
      await cleanup();
    }
  });
});
