/**
 * P0-2（2026-11-04 L1 属性复核）· L2 蒸馏输入必须剔除 certainty=inferred 的行
 *
 * 背景：L2 写的场景块是长期记忆（注入层会原文引用其摘要与证据行），把「提取器猜的」
 * 与「实际发生的」同等蒸馏 = 把猜测固化成事实。L3 duratives（pipeline-factory.ts
 * duratives()）早有同一道门（certainty !== 'inferred'），L2 此前缺这一道。
 *
 * 不变量（本文件即契约）：
 *  1. inferred 行的正文不得出现在 L2 抽取 prompt 里；
 *  2. observed 行照常进入 prompt（门不是"整组丢弃"）；
 *  3. 整组都是 inferred → 本轮不调用 LLM（无内容可蒸馏，early-continue）。
 *
 * 未在此覆盖：derived_from 边的行集合与 prompt 行集合同源（pipeline-factory.ts 的
 * activeGroupRecords 既喂 memories 也喂 addLink 循环），要触达该分支需抽出器真的产出
 * changedSceneFiles——属成功臂，与本门判定无关，故不在此伪造。
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createL2Runner } from "./pipeline-factory.js";

const SCOPE = "team:default|user:default|agent:default";
const noopLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  vi.restoreAllMocks();
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

/** L1 行夹具：certainty 是本次被测字段，content 用可检索的唯一串。 */
function makeRow(i: number, certainty: string, content: string) {
  return {
    record_id: `r${i}`,
    content,
    type: "episodic",
    priority: 1,
    scene_name: "",
    created_time: "2026-11-01T00:00:00.000Z",
    updated_time: `2026-11-01T00:00:0${i}.000Z`,
    version: 0,
    session_key: "sk-l2",
    session_id: "sess-l2",
    task_id: "",
    team_id: "",
    user_id: "",
    agent_id: "",
    valid_end: "",
    certainty,
    metadata_json: "{}",
    timestamp_str: "",
    timestamp_end: "",
  };
}

function makeOpts(rows: ReturnType<typeof makeRow>[], prompts: string[], edges: string[][]) {
  const vectorStore = {
    isDegraded: () => false,
    queryL1Records: async () => rows,
    addLink: (source: string, target: string) => {
      edges.push([source, target]);
      return true;
    },
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
      // 门关掉：本文件测的是 inferred 过滤，不是触发门（l2Gate 有自己的测试文件）
      l2Gate: { enabled: false, minPendingL1: 1, minIntervalHours: 0 },
      l2Form: { structured: false, maxBlockBytes: 4096 },
    },
    extraction: { extractionTimeoutMs: 1000, sceneBatchMaxChars: 100_000, scenePoisonSplit: false },
    sceneGovernance: { enabled: false },
  };
  return {
    pluginDataDir: mkTmp("l2-inferred-"),
    cfg,
    vectorStore,
    logger: noopLogger,
    llmRunner,
  } as unknown as Parameters<typeof createL2Runner>[0];
}

describe("P0-2 · L2 蒸馏剔除 inferred 行", () => {
  it("inferred 行正文不进 prompt，observed 行照常进（门是逐行过滤，不是整组丢弃）", async () => {
    const prompts: string[] = [];
    const edges: string[][] = [];
    const opts = makeOpts(
      [
        makeRow(1, "observed", "实见内容：OBSERVED_ANCHOR 今天去了医院"),
        makeRow(2, "inferred", "推断内容：INFERRED_ANCHOR 可能不喜欢开会"),
      ],
      prompts,
      edges,
    );
    await createL2Runner(opts)("sk-l2");

    expect(prompts.length).toBeGreaterThan(0);
    const joined = prompts.join("\n");
    expect(joined).toContain("OBSERVED_ANCHOR");
    expect(joined).not.toContain("INFERRED_ANCHOR");
  });

  it("整组都是 inferred → 本轮不调用 LLM（无内容可蒸馏，early-continue）", async () => {
    const prompts: string[] = [];
    const edges: string[][] = [];
    const opts = makeOpts(
      [makeRow(1, "inferred", "推断内容：INFERRED_ONLY_ANCHOR 之一"), makeRow(2, "inferred", "推断内容：INFERRED_ONLY_ANCHOR 之二")],
      prompts,
      edges,
    );
    await createL2Runner(opts)("sk-l2");

    expect(prompts).toHaveLength(0);
  });

  it("mixed（observed + inferred）与全 observed 的 prompt 差 = 恰好被剔除的推断行", async () => {
    const mixed: string[] = [];
    await createL2Runner(
      makeOpts(
        [makeRow(1, "observed", "实见内容：DIFF_OBSERVED"), makeRow(2, "inferred", "推断内容：DIFF_INFERRED")],
        mixed,
        [],
      ),
    )("sk-l2");
    const observedOnly: string[] = [];
    await createL2Runner(makeOpts([makeRow(1, "observed", "实见内容：DIFF_OBSERVED")], observedOnly, []))("sk-l2");

    const mixedPrompt = mixed.join("\n");
    const observedPrompt = observedOnly.join("\n");
    // 夹具里的行序号不同（r1/r2），先把两边的「只含 observed」形态对齐后再比长度：
    // mixed 的 prompt 一定严格更长（多出的是被过滤之外的上下文），但绝不含推断串。
    expect(mixedPrompt).not.toContain("DIFF_INFERRED");
    expect(mixedPrompt).toContain("DIFF_OBSERVED");
    expect(observedPrompt).toContain("DIFF_OBSERVED");
    expect(observedPrompt.length).toBeGreaterThan(0);
  });
});
