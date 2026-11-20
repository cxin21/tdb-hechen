/**
 * L1 单会话条数上限：超限时按 priority 保留，而不是截掉尾部。
 *
 * 背景（2026-11-18 审计）：提示词要求「超出上限时保留 priority 最高」，
 * 但代码此前是 slice(0, max)，模型不保证有序输出，最该留的那条会被丢。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractL1Memories } from "./l1-extractor.js";

const MSGS = [
  { id: "m1", role: "user" as const, content: "这次上线时间定在周五，负责人是我。", timestamp: 1_700_000_000_000 },
  { id: "m2", role: "user" as const, content: "另外以后所有上线都必须先过灰度。", timestamp: 1_700_000_000_500 },
];

/** 低优先级在前：旧 slice 会留 60/95，新逻辑应留 95/80。 */
const RAW = JSON.stringify([
  {
    scene_name: "上线安排",
    message_ids: ["m1", "m2"],
    memories: [
      { content: "用户（未提供）把上线时间定在周五", type: "episodic", priority: 60 },
      { content: "用户要求以后所有上线都必须先过灰度", type: "instruction", priority: 95 },
      { content: "用户是这次上线的负责人", type: "persona", priority: 80 },
    ],
  },
]);

function makeLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as never;
}

describe("L1 条数上限按 priority 保留", () => {
  it("超限时保留 priority 最高的两条，且不改变其余顺序", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "l1-limit-"));
    try {
      const llmRunner = {
        run: async (args: { taskId?: string }) => (args.taskId === "l1-extraction" ? RAW : "{}"),
      } as never;
      const result = await extractL1Memories({
        messages: MSGS as never,
        sessionKey: "sess-limit",
        baseDir,
        memoryConfig: { coreMemory: { selfIdentity: { enabled: false } } } as never,
        options: { enableDedup: false, llmRunner, maxMemoriesPerSession: 2 },
        logger: makeLogger(),
      });

      const contents = result.records.map((r) => String(r.content));
      expect(contents).toHaveLength(2);
      expect(contents.join("\n")).toContain("先过灰度");
      expect(contents.join("\n")).toContain("负责人");
      expect(contents.join("\n")).not.toContain("周五");
      // 原顺序保留：instruction(95) 在 persona(80) 之前，和输入相对顺序一致。
      expect(contents[0]).toContain("先过灰度");
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
