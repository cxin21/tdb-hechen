/**
 * P0-2（2026-11-04 L1 属性复核）：L2 蒸馏输入不得含推断行（certainty=inferred）。
 *
 * 契约：
 *  1. certainty!=='inferred' 的行照常进 scene 抽取 prompt（逐位等于旧行为）；
 *  2. certainty==='inferred' 的行不进 prompt（猜测不得固化成长期场景块）；
 *  3. 全组只有推断行 → 本轮跳过抽取（不消费、不产出），而不是拿空批去调 LLM；
 *  4. 失效行（valid_end）仍按原逻辑排除（本门不改变既有语义）。
 */
import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createL2Runner } from "./pipeline-factory.js";
import { syncSceneIndex } from "../core/scene/scene-index.js";

const SCOPE = "team:default|user:default|agent:default";
const noopLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop()!;
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* 无害 */
    }
  }
});

function groupDataDir(pluginDataDir: string): string {
  return path.join(pluginDataDir, "profiles", encodeURIComponent(SCOPE));
}

/** 预置一个已有场景块 + 索引 → extract() 的 emptyExtraction 为 false（走成功臂）。 */
async function seedSceneBlock(dir: string): Promise<void> {
  const blocksDir = path.join(dir, "scene_blocks");
  fs.mkdirSync(blocksDir, { recursive: true });
  fs.writeFileSync(
    path.join(blocksDir, "Existing.md"),
    [
      "-----META-START-----",
      "created: 2026-01-01T00:00:00.000Z",
      "updated: 2026-01-01T00:00:00.000Z",
      "summary: existing scene block for L2 inferred gate fixtures",
      "heat: 1",
      "-----META-END-----",
      "",
      "## 核心叙事",
      "",
      "既有场景正文。",
      "",
    ].join("\n"),
    "utf-8",
  );
  await syncSceneIndex(dir);
}

function row(id: string, content: string, over: Record<string, unknown> = {}) {
  return {
    record_id: id,
    content,
    type: "episodic",
    priority: 1,
    scene_name: "",
    created_time: "2026-11-01T00:00:00.000Z",
    updated_time: "2026-11-01T00:00:00.000Z",
    version: 0,
    session_key: "sk-1",
    session_id: "sess-1",
    task_id: "",
    team_id: "",
    user_id: "",
    agent_id: "",
    valid_end: "",
    certainty: "observed",
    metadata_json: "{}",
    timestamp_str: "",
    timestamp_end: "",
    ...over,
  };
}

function makeOpts(params: { pluginDataDir: string; rows: ReturnType<typeof row>[]; prompts: string[] }) {
  const { pluginDataDir, rows, prompts } = params;
  const vectorStore = {
    isDegraded: () => false,
    queryL1Records: async (_filter: unknown) => rows,
  };
  const llmRunner = {
    run: async (p: { prompt?: string }) => {
      prompts.push(String(p.prompt ?? ""));
      return "";
    },
  };
  const cfg = {
    persona: {
      model: "test-model",
      promptMode: "chat",
      maxScenes: 15,
      sceneBackupCount: 10,
      l2Gate: { enabled: false, minPendingL1: 30, minIntervalHours: 6 },
      l2Form: { structured: false, maxBlockBytes: 4096 },
    },
    extraction: { extractionTimeoutMs: 1000, sceneBatchMaxChars: 100_000, scenePoisonSplit: false },
    sceneGovernance: { enabled: false },
  };
  return { pluginDataDir, cfg, vectorStore, logger: noopLogger, llmRunner } as unknown as Parameters<
    typeof createL2Runner
  >[0];
}

describe("P0-2 · L2 蒸馏输入推断门", () => {
  it("observed 行进 prompt、inferred 行不进（同一批混排）", async () => {
    const dir = mkTmp("l2-inferred-mixed-");
    await seedSceneBlock(groupDataDir(dir));
    const prompts: string[] = [];
    const rows = [
      row("r-obs", "实测行甲：周三发布窗口固定为下午三点"),
      row("r-inf", "推断行乙：用户可能更喜欢周四发布", { certainty: "inferred" }),
    ];
    const runner = createL2Runner(makeOpts({ pluginDataDir: dir, rows, prompts }));

    await runner("sk-1");

    const all = prompts.join("\n");
    expect(all).toContain("实测行甲");
    expect(all).not.toContain("推断行乙");
  });

  it("全组只有推断行 → 本轮跳过抽取（一次 LLM 调用都不发）", async () => {
    const dir = mkTmp("l2-inferred-only-");
    await seedSceneBlock(groupDataDir(dir));
    const prompts: string[] = [];
    const rows = [row("r-inf", "推断行丙：猜测内容不得进入场景块", { certainty: "inferred" })];
    const runner = createL2Runner(makeOpts({ pluginDataDir: dir, rows, prompts }));

    await runner("sk-1");

    expect(prompts.length).toBe(0);
  });

  it("certainty 缺省（老数据）按 observed 处理，照常进 prompt", async () => {
    const dir = mkTmp("l2-inferred-absent-");
    await seedSceneBlock(groupDataDir(dir));
    const prompts: string[] = [];
    const r = row("r-legacy", "老数据行：没有 certainty 列历史行");
    delete (r as { certainty?: string }).certainty;
    const runner = createL2Runner(makeOpts({ pluginDataDir: dir, rows: [r], prompts }));

    await runner("sk-1");

    expect(prompts.join("\n")).toContain("老数据行");
  });
});
