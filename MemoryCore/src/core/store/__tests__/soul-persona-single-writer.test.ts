/**
 * 单写者守卫（2026-11-08）：commitSoulPersona 拒收没有主人的 human 行。
 *
 * 为什么在这里锁：human 层（「关于你」的人物档案）只由 core/person/profile-distiller.ts 写，
 * 它每条都带 meta.person.key。人格改写产线如果再写这一层，就是两个写者抢同一格——
 * 两边判据不同（一边只要求逐字原话，一边要九字段+主语判据+TTL）、配额不同，
 * 同字段谁覆盖谁没有规则。门已经拒了候选，这里是库层最后一道：即使有人绕过门，
 * 没有 person.key 的 human 行也落不进库，且计数回给调用方（可见，不静默）。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../sqlite.js";
import type { PersonaItem } from "../../soul/types.js";

const TENANT = { teamId: "team-a", userId: "user-a", agentId: "agent-a" };

function makeStore(): VectorStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "single-writer-"));
  const store = new VectorStore(path.join(dir, "vectors.db"), 0);
  const res = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级：${JSON.stringify(res)}`);
  return store;
}

const NOW = "2026-11-08T00:00:00.000Z";

function item(itemId: string, text: string, meta?: Record<string, unknown>): PersonaItem {
  return {
    itemId,
    layer: "human" as const,
    text,
    state: "active" as const,
    weight: 1,
    evidenceIds: ["ep-a1"],
    evidenceDays: ["2026-11-08"],
    evidenceOrigins: ["episode" as const],
    createdAt: NOW,
    updatedAt: NOW,
    lastEvidenceAt: NOW,
    contradictions: 0,
    ...(meta === undefined ? {} : { meta }),
  };
}

describe("human 层单写者守卫", () => {
  it("没有 meta.person.key 的 human 行被跳过，并回 skippedHuman 计数", async () => {
    const store = makeStore();
    const res = await store.commitSoulPersona(TENANT, {
      upsert: [
        item("human:orphan", "称呼：无主的行"),
        item("human:owned", "称呼：有主的行", { person: { key: "p_owner" } }),
      ],
      ledger: [],
    });
    expect(res.upserted).toBe(1);
    expect(res.skippedHuman).toBe(1);
    const rows = store.listSoulPersona(TENANT).filter((i) => i.layer === "human");
    expect(rows.map((r) => r.itemId)).toEqual(["human:owned"]);
  });

  it("person.key 是空白串同样算无主；非 human 层不受影响", async () => {
    const store = makeStore();
    const res = await store.commitSoulPersona(TENANT, {
      upsert: [
        item("human:blank", "称呼：空白主" , { person: { key: "   " } }),
        { ...item("identity:x", "我宁可慢一点把账算清"), layer: "identity" as const },
      ],
      ledger: [],
    });
    expect(res.upserted).toBe(1);
    expect(res.skippedHuman).toBe(1);
    const rows = store.listSoulPersona(TENANT);
    expect(rows.map((r) => r.itemId)).toEqual(["identity:x"]);
  });

  it("一次全被跳过时不报错，只回 skippedHuman 与 upserted=0（不毁掉同批其它层）", async () => {
    const store = makeStore();
    const res = await store.commitSoulPersona(TENANT, {
      upsert: [item("human:o1", "称呼：一"), item("human:o2", "称呼：二")],
      ledger: [],
    });
    expect(res.upserted).toBe(0);
    expect(res.skippedHuman).toBe(2);
    expect(store.listSoulPersona(TENANT)).toHaveLength(0);
  });
});