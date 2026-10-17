/**
 * #44（D-44-2 refKey 显式契约）：store 层归一化——trim + 空白→无关联（''）。
 *
 * 合同：refKey 是「任务/上下文关联键」的显式手工契约字段（Panel/API 唯一生产写入方），
 * 带入的意外空白不得成为独立指涉物（"  t-9  " 与 "t-9" 必须同锚）；纯空白=无关联，
 * 不落垃圾键（ADR0003 真实性硬边界：宁缺毋滥）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VectorStore } from "../sqlite.js";

describe("#44 · upsertSoulPromise refKey 归一化（trim + 空白→''）", () => {
  it("带空白 refKey 归一为 trim 值；纯空白归一为 ''", async () => {
    const dir = mkdtempSync(join(tmpdir(), "soul-promise-refkey-"));
    let store: VectorStore | null = null;
    try {
      store = new VectorStore(join(dir, "vectors.db"), 0);
      await store.init();
      const t = { teamId: "t1", userId: "u1", agentId: "a1" };

      const withRef = await store.upsertSoulPromise!(t, { content: "承诺甲", source: "user", refKey: "  t-9  " });
      const rowA = store.listSoulPromises!(t).find((r) => r.promiseId === withRef.promiseId);
      expect(rowA?.refKey).toBe("t-9");

      const blank = await store.upsertSoulPromise!(t, { content: "承诺乙", source: "user", refKey: "   " });
      const rowB = store.listSoulPromises!(t).find((r) => r.promiseId === blank.promiseId);
      expect(rowB?.refKey ?? "").toBe("");
    } finally {
      store?.close(); // Windows：不关句柄直接 rmSync 报 EBUSY
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
