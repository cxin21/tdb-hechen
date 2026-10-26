/**
 * L1 分类闸门（2026-10-26）：classified 模式下 L0 每轮 = 1 条 real 用户消息 +
 * N 条脚手架（runtime context / system-reminder / 压缩 nudge / 技能正文）。
 *
 * 生产实测（2026-10-26 晚，/data/tdai-memory）：L0 149 行里 real 仅 9 行，
 * 而 L1 抽出 133 条记忆、其中 85 条源自脚手架文本 → instruction 型记忆爆表
 * （「用户要求执行 compress 时全程静默」这类系统提示复述）。
 *
 * 不变量（本文件钉死）：
 *  - 结构闸门：classification ∈ {scaffold, artifact, echo, dup} 的 L0 行不进 LLM，
 *    **但「有内容的脚手架」豁免**——压缩摘要段（[Compressed conversation section]）
 *    与后台回执（Background subagent … finished）虽归类 scaffold，正文却是任务状态
 *    与评审结论（2026-10-26 生产 L0 回放实测：86 条 scaffold 里 19 条含 KNOWLEDGE_SERVICE_KEY
 *    等真实工作事实），整类挡掉会丢掉长会话的骨架；
 *  - 内容兜底：无标签行（classified 上线前的历史行）命中脚手架特征串也不进 LLM；
 *  - 游标安全：被挡的行照样算进 maxRecordedAtMs —— 整批都是脚手架时游标必须推进，
 *    否则同批被无限重取（游标卡死）；
 *  - 全批被挡时不调用 LLM。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createL1Runner } from "./pipeline-factory.js";
import { CheckpointManager } from "./checkpoint.js";

const loggerStub = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

type Msg = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  recordedAtMs: number;
  classification?: string;
};

function makeRunnerOpts(dir: string, llmRunner: unknown, messages: Msg[]) {
  const vectorStore = {
    isDegraded: () => false,
    upsertL1: async () => true,
    queryL0GroupedBySessionId: async () => [
      { sessionId: "sess-gate-1", teamId: "team-x", userId: "user-x", agentId: "agent-x", messages },
    ],
  };
  const cfg = {
    extraction: { enableDedup: false, maxMemoriesPerSession: 20, durativeEnabled: false },
    links: { enabled: false, minSimilarity: 0.3 },
    embedding: { conflictRecallTopK: 0 },
  };
  return {
    pluginDataDir: dir,
    cfg,
    openclawConfig: undefined,
    vectorStore,
    embeddingService: undefined,
    logger: loggerStub,
    llmRunner,
  } as unknown as Parameters<typeof createL1Runner>[0];
}

const SCENE_JSON = JSON.stringify([
  {
    scene_name: "闸门测试情境",
    message_ids: ["real-1"],
    memories: [
      { content: "用户要求把爱心动画从粒子版改成绘制版（动画太卡）", type: "instruction", source_message_ids: ["real-1"] },
    ],
  },
]);

function recordingRunner(prompts: string[]) {
  return {
    run: async (p: { prompt: string }) => {
      prompts.push(String(p.prompt ?? ""));
      return SCENE_JSON;
    },
  };
}

function readCursor(dir: string): Promise<number> {
  const checkpoint = new CheckpointManager(dir, loggerStub as never);
  return checkpoint.read().then((cp) => {
    const st = checkpoint.getRunnerState(cp, "sess-gate-1") as { last_l1_cursor?: number };
    return st.last_l1_cursor ?? 0;
  });
}

const T0 = 1_700_000_000_000;

describe("L1 分类闸门 · 脚手架不进 LLM", () => {
  it("scaffold/artifact 行被结构性挡掉，real 行照常进入 prompt，游标推进", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l1-gate-"));
    try {
      const prompts: string[] = [];
      const messages: Msg[] = [
        { id: "real-1", role: "user", content: "太卡了这个，你改一下形式吧，改成绘制的动画", timestamp: T0, recordedAtMs: T0, classification: "real" },
        { id: "scaf-1", role: "user", content: "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.", timestamp: T0 + 1, recordedAtMs: T0 + 1, classification: "scaffold" },
        { id: "art-1", role: "user", content: '<skill_content name="implement"> 技能正文占位 </skill_content>', timestamp: T0 + 2, recordedAtMs: T0 + 2, classification: "artifact" },
        { id: "dup-1", role: "user", content: "重复内容占位（dup）", timestamp: T0 + 3, recordedAtMs: T0 + 3, classification: "dup" },
      ];
      const runner = createL1Runner(makeRunnerOpts(dir, recordingRunner(prompts), messages));
      const res = await runner({ sessionKey: "sess-gate-1" });

      // 提取链路可能有多趟 LLM 调用（提取 + 判重/富化），脚手架不得出现在任何一趟
      expect(prompts.length).toBeGreaterThanOrEqual(1);
      const prompt = prompts.join("\n----\n");
      expect(prompt).toContain("改成绘制的动画");
      expect(prompt).not.toContain("runtime-context snapshots");
      expect(prompt).not.toContain("skill_content");
      expect(prompt).not.toContain("重复内容占位");

      // 游标覆盖整批（含被挡行）→ 不会重取
      expect(await readCursor(dir)).toBe(T0 + 3);
      expect(res.processedCount).toBe(4);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });

  it("无标签行（classified 上线前/非 DSH 客户端）：内容兜底闸门拦下脚手架", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l1-gate-content-"));
    try {
      const prompts: string[] = [];
      const messages: Msg[] = [
        { id: "real-1", role: "user", content: "把这个接口的超时从 5s 调到 8s", timestamp: T0, recordedAtMs: T0 },
        { id: "plain-nudge", role: "user", content: "⚠️ Context limit reached — compress now. Prioritize consumed tool outputs. Compression Philosophy: - All compression serves the primary task", timestamp: T0 + 1, recordedAtMs: T0 + 1 },
        { id: "plain-skill", role: "user", content: 'entry point </skill_resources> ## Overview 技能正文', timestamp: T0 + 2, recordedAtMs: T0 + 2 },
      ];
      const runner = createL1Runner(makeRunnerOpts(dir, recordingRunner(prompts), messages));
      await runner({ sessionKey: "sess-gate-1" });

      expect(prompts.length).toBeGreaterThanOrEqual(1);
      const all = prompts.join("\n----\n");
      expect(all).toContain("超时从 5s 调到 8s");
      expect(all).not.toContain("Compression Philosophy");
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });

  it("有内容的脚手架豁免：压缩摘要段与后台回执照常进 LLM", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l1-gate-bearing-"));
    try {
      const prompts: string[] = [];
      const messages: Msg[] = [
        { id: "plain-1", role: "user", content: "⚠️ Context limit reached — compress now. Prioritize consumed tool outputs. Compression Philosophy: - All compression serves the primary task", timestamp: T0, recordedAtMs: T0, classification: "scaffold" },
        { id: "sum-1", role: "user", content: "[Compressed conversation section] — #115 上游对比 + 本仓现状勘察（尚未写代码）\n## 用户目标与硬约束\n- User said (m00002): \"/implement https://github.com/cxin21/tdb-hechen/issues/115\"", timestamp: T0 + 1, recordedAtMs: T0 + 1, classification: "scaffold" },
        { id: "sub-1", role: "user", content: "Background subagent 963e5b35-2789-499e-b2e4-db64db53cbca finished and reported: SPEC 轴复审 AC1=COVERED、AC3=COVERED且真红。", timestamp: T0 + 2, recordedAtMs: T0 + 2, classification: "scaffold" },
      ];
      const runner = createL1Runner(makeRunnerOpts(dir, recordingRunner(prompts), messages));
      const res = await runner({ sessionKey: "sess-gate-1" });

      expect(prompts.length).toBeGreaterThanOrEqual(1);
      const prompt = prompts.join("\n----\n");
      // 豁免行进入 prompt；纯 nudge 不得进入
      expect(prompt).toContain("Compressed conversation section");
      expect(prompt).toContain("Background subagent 963e5b35");
      expect(prompt).not.toContain("Compression Philosophy");
      expect(await readCursor(dir)).toBe(T0 + 2);
      expect(res.processedCount).toBe(3);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });

  it("整批脚手架：不调用 LLM，游标仍推进（防同批无限重取）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l1-gate-allscaffold-"));
    try {
      const prompts: string[] = [];
      const messages: Msg[] = [
        { id: "s1", role: "user", content: "The approval policy changed from \"ask\" to \"never\" (changed by the user).", timestamp: T0, recordedAtMs: T0, classification: "scaffold" },
        { id: "s2", role: "user", content: "<system-reminder> workspace instructions </system-reminder>", timestamp: T0 + 1, recordedAtMs: T0 + 1, classification: "scaffold" },
        { id: "s3", role: "user", content: "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.", timestamp: T0 + 2, recordedAtMs: T0 + 2, classification: "scaffold" },
      ];
      const runner = createL1Runner(makeRunnerOpts(dir, recordingRunner(prompts), messages));
      const res = await runner({ sessionKey: "sess-gate-1" });

      expect(prompts).toHaveLength(0);
      expect(res.storedCount).toBe(0);
      expect(await readCursor(dir)).toBe(T0 + 2);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  });
});
