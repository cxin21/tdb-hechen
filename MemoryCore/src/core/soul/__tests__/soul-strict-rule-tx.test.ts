/**
 * S6 事务验收：strict_rule 投影与 persona/账本同事务。
 * 两条断言：正常路径一次 commit 同时写 persona + core_memory.strict_rule；
 * 账本写入抛错时整体回滚，strict_rule 不残留（否则「卡里有、槽里没有」会长期漂移）。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseConfig } from "../../../config.js";
import { createStoreBundle } from "../../store/factory.js";
import type { PersonaItem, SoulLedgerEntry } from "../types.js";

let dataDir: string;
let bundle: Awaited<ReturnType<typeof createStoreBundle>>;
const TENANT = { teamId: "t1", userId: "u1", agentId: "a1" };

function item(): PersonaItem {
  return {
    itemId: "identity:tx1",
    layer: "identity",
    text: "用户负责 TDB 记忆系统的版本发布与回归验证",
    state: "active",
    weight: 0.7,
    evidenceIds: ["r1", "r2", "r3"],
    evidenceDays: ["2026-11-01"],
    evidenceOrigins: ["l1"],
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    lastEvidenceAt: "2026-11-01T00:00:00.000Z",
  };
}

function ledger(id: string): SoulLedgerEntry {
  return {
    entryId: id,
    at: "2026-11-07T00:00:00.000Z",
    trigger: "lifecycle",
    layer: "identity",
    itemId: "identity:tx1",
    action: "admit",
    gates: ["ok"],
    reason: "准入",
    evidenceIds: ["r1"],
  };
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "tdai-soul-tx-"));
  bundle = createStoreBundle(parseConfig({}), { dataDir });
  (bundle.store as unknown as { init?: () => unknown }).init?.();
});

afterEach(async () => {
  await bundle.store.close?.();
  await rm(dataDir, { recursive: true, force: true });
});

describe("commitSoulPersona × strict_rule 同事务（S6）", () => {
  it("一次提交同时落 persona 与 core_memory.strict_rule（逐字、source=soul-redline）", async () => {
    const res = await bundle.store.commitSoulPersona!(
      TENANT,
      { upsert: [item()], ledger: [ledger("tx-ok")] },
      { strictRule: "- 绝不可删除任何生产记忆记录" },
    );
    expect(res.upserted).toBe(1);
    expect(res.strictRule).toBe(true);
    const slots = await Promise.resolve(bundle.store.readCore!(TENANT));
    const strict = slots.find((s) => s.slot === "strict_rule");
    expect(strict?.content).toBe("- 绝不可删除任何生产记忆记录");
    expect(strict?.source).toBe("soul-redline");
    expect(strict?.version).toBe(1);
  });

  it("账本写入失败 → 整体回滚，strict_rule 不残留", async () => {
    const bad = { ...ledger("tx-bad"), at: { not: "a string" } } as unknown as SoulLedgerEntry;
    await expect(
      bundle.store.commitSoulPersona!(
        TENANT,
        { upsert: [item()], ledger: [bad] },
        { strictRule: "- 绝不可删除任何生产记忆记录" },
      ),
    ).rejects.toThrow();
    const slots = await Promise.resolve(bundle.store.readCore!(TENANT));
    expect(slots.find((s) => s.slot === "strict_rule")).toBeUndefined();
  });
});
