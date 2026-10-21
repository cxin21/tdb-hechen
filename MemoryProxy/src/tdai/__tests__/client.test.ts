import { describe, it, expect } from "vitest";
import { chunkConversationMessages } from "../client.js";
import type { TdaiMessage } from "../types.js";

// #86：>8192 字符消息分片时 classification 丢失（恰是 scaffold 标签最密集形态，
// runtime-context 快照等巨块），损及 #84 存量回填前提。契约=分片继承首片标签。
describe("chunkConversationMessages - #86 分片继承 classification", () => {
  it(">8192 消息分片后逐片继承 classification，内容重组无损", () => {
    const msg: TdaiMessage = { role: "user", content: "x".repeat(20000), classification: "scaffold" };
    const chunks = chunkConversationMessages([msg]);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.classification).toBe("scaffold");
      expect(c.content.length).toBeLessThanOrEqual(8192);
      expect(c.role).toBe("user");
    }
    expect(chunks.map((c) => c.content).join("")).toBe("x".repeat(20000));
  });

  it("无 classification 的消息分片不引入该字段（保持 undefined）", () => {
    const chunks = chunkConversationMessages([{ role: "assistant", content: "y".repeat(9000) }]);
    expect(chunks.length).toBe(2);
    expect(chunks[0].classification).toBeUndefined();
  });

  it("短消息（<=8192）整条透传不复制", () => {
    const msg: TdaiMessage = { role: "user", content: "short", classification: "real" };
    const chunks = chunkConversationMessages([msg]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(msg);
  });
});
