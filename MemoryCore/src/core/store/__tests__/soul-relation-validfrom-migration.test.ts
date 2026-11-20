/**
 * 存量关系边 valid_from 回填（issue #180 §S9 / Round3 阶段0 的迁移脚本）。
 *
 * 这条测试守两件事：
 *   1) 只读演练不写库，且报出可回填条数；
 *   2) --apply 后 valid_from = 证据里最早的 created_time，valid_to 早于它时被夹取（不倒挂），
 *      重跑幂等（第二次可回填 0 条）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { VectorStore } from "../sqlite.js";
import type { CoreTenant } from "../types.js";

const TENANT: CoreTenant = { teamId: "t-mig", userId: "u-mig", agentId: "a-mig" };
const SCRIPT = path.join(process.cwd(), "scripts", "migrate-soul-relation-validfrom.mjs");

type Raw = {
  prepare(sql: string): { all(...p: unknown[]): unknown[]; get(...p: unknown[]): unknown; run(...p: unknown[]): unknown };
};
const raw = (store: VectorStore) => (store as unknown as { db: Raw }).db;

function makeStore(): { store: VectorStore; dbPath: string } {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "soul-validfrom-mig-")), "vectors.db");
  const store = new VectorStore(dbPath, 0);
  const res = store.init();
  if (store.isDegraded()) throw new Error("临时库初始化降级（环境问题）：" + res.reason);
  return { store, dbPath };
}

function l1(store: VectorStore, id: string, createdAt: string): void {
  store.upsertL1!(
    {
      id,
      content: "周衡是我直属上级",
      type: "episodic",
      priority: 3,
      scene_name: "t",
      source_message_ids: [id + "-msg"],
      metadata: { persons: [{ key: "p_he", role: "speaker" }] } as never,
      timestamps: [createdAt],
      createdAt,
      updatedAt: createdAt,
      version: 1,
      sessionKey: "s-mig",
      sessionId: "s-mig",
      teamId: TENANT.teamId,
      userId: TENANT.userId,
      agentId: TENANT.agentId,
    },
    undefined,
  );
}

function relation(store: VectorStore, relId: string, recordId: string, evidenceJson: string, validFrom: string, validTo: string | null): void {
  raw(store)
    .prepare(
      `INSERT INTO soul_person_relation
         (rel_id, team_id, user_id, agent_id, subj_key, pred, obj_key, direction, quote, record_id,
          valid_from, valid_to, created_at, updated_at, evidence_json)
       VALUES (?, ?, ?, ?, 'p_he', '上级', 'p_zhou', 'out', '周衡是我直属上级', ?,
               ?, ?, '2026-10-10T00:00:00.000Z', '2026-10-10T00:00:00.000Z', ?)`,
    )
    .run(relId, TENANT.teamId, TENANT.userId, TENANT.agentId, recordId, validFrom, validTo, evidenceJson);
}

function runScript(dbPath: string, ...extra: string[]): string {
  return execFileSync(process.execPath, [SCRIPT, "--db", dbPath, ...extra], { encoding: "utf8" });
}

describe("migrate-soul-relation-validfrom.mjs（存量 valid_from 回填）", () => {
  it("演练不写库；--apply 用最早证据时间回填并把过期的 valid_to 夹到 valid_from；重跑幂等", () => {
    const { store, dbPath } = makeStore();
    l1(store, "r1", "2026-09-01T00:00:00.000Z");
    l1(store, "r2", "2026-09-05T00:00:00.000Z");
    relation(store, "rel-1", "r1", JSON.stringify([{ recordId: "r2", at: "2026-09-05T00:00:00.000Z" }]), "2026-10-10T00:00:00.000Z", "2026-10-20T00:00:00.000Z");
    relation(store, "rel-2", "r2", "[]", "2026-10-10T00:00:00.000Z", "2026-08-01T00:00:00.000Z");

    const read = () =>
      raw(store)
        .prepare("SELECT rel_id, valid_from, valid_to FROM soul_person_relation ORDER BY rel_id")
        .all() as Array<{ rel_id: string; valid_from: string; valid_to: string | null }>;

    const before = read();
    const dry = runScript(dbPath);
    expect(dry).toContain("可回填 2 条");
    expect(read()).toEqual(before);

    const applied = runScript(dbPath, "--apply");
    expect(applied).toContain("已回填 2 条");
    const after = read();
    expect(after.find((r) => r.rel_id === "rel-1")).toMatchObject({
      valid_from: "2026-09-01T00:00:00.000Z",
      valid_to: "2026-10-20T00:00:00.000Z",
    });
    // rel-2 的 valid_to 早于新 valid_from（2026-09-05）→ 夹到 valid_from，绝不留倒挂区间。
    expect(after.find((r) => r.rel_id === "rel-2")).toMatchObject({
      valid_from: "2026-09-05T00:00:00.000Z",
      valid_to: "2026-09-05T00:00:00.000Z",
    });

    expect(runScript(dbPath)).toContain("可回填 0 条");
  });
});
