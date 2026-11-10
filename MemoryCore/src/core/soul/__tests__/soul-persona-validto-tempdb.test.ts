/**
 * 判据 4 的可验方式（临时库，零写生产）：
 *   freezeItem 设的 validTo 必须经 commitSoulPersona 落库、再由 listSoulPersona 原样读回；
 *   planRevive 清掉 validTo 后同一路径必须读回 undefined（不许残留旧失效期）。
 *
 * 落库口径：零 DDL，validTo/supersededBy 存在 meta_json 的保留键里，读侧复原到顶层字段。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../store/sqlite.js";
import type { PersonaItem } from "../types.js";
import { freezeItem, planRevive } from "../persona.js";

const T = { teamId: "t-validto", userId: "u-validto", agentId: "a-validto" };
const CREATED = "2026-11-01T00:00:00.000Z";
const FROZEN_AT = "2026-11-07T02:00:00.000Z";
const REVIVED_AT = "2026-11-07T03:00:00.000Z";

function item(): PersonaItem {
  return {
    itemId: "persona:t-validto",
    layer: "identity",
    text: "先取证再改代码",
    state: "active",
    weight: 0.8,
    evidenceIds: ["ep-1"],
    evidenceDays: ["2026-11-01"],
    evidenceOrigins: ["episode"],
    createdAt: CREATED,
    updatedAt: CREATED,
    lastEvidenceAt: CREATED,
    contradictions: 0,
    meta: { scope: "global" },
  };
}

describe("validTo 持久化：freeze → commit → list 读回不丢（判据 4）", () => {
  it("冻结写回 validTo，复活清掉；层 meta 不被保留键污染", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "soul-validto-"));
    const store = new VectorStore(path.join(dir, "vectors.db"), 0);
    try {
      store.init();
      if (store.isDegraded()) throw new Error("临时库初始化降级");

      // 1) 未冻结：无 validTo，层 meta 原样
      await store.commitSoulPersona(T, { upsert: [item()], ledger: [] });
      const before = store.listSoulPersona(T);
      expect(before).toHaveLength(1);
      expect(before[0]!.validTo).toBeUndefined();
      expect(before[0]!.meta).toEqual({ scope: "global" });

      // 2) 冻结：validTo 落库并可读回
      const frozen = freezeItem(before[0]!, FROZEN_AT);
      await store.commitSoulPersona(T, { upsert: [frozen], ledger: [] });
      const afterFreeze = store.listSoulPersona(T);
      expect(afterFreeze[0]!.state).toBe("frozen");
      expect(afterFreeze[0]!.weight).toBe(0.4);
      expect(afterFreeze[0]!.validTo).toBe(FROZEN_AT);
      // 保留键不混进层 meta（注入侧只该看到 scope 这类层专属字段）
      expect(afterFreeze[0]!.meta).toEqual({ scope: "global" });

      // 3) 复活：validTo 必须真的消失，而不是留在 meta 里被读侧捡回来
      const revived = planRevive(afterFreeze[0]!, REVIVED_AT, ["ep-2"]);
      await store.commitSoulPersona(T, { upsert: [revived], ledger: [] });
      const afterRevive = store.listSoulPersona(T);
      expect(afterRevive[0]!.state).toBe("active");
      expect(afterRevive[0]!.validTo).toBeUndefined();
      expect(afterRevive[0]!.evidenceIds).toContain("ep-2");
    } finally {
      try {
        store.close();
      } catch {
        /* 已关闭 */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
