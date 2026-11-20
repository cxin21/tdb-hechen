/**
 * A3 Round8 CP5：游标谓词 (rev, record_id) 与排序键必须同键。
 *
 * 旧排序是 `updated_at ASC, at ASC, record_id ASC`，而游标只带 (rev, record_id)。
 * 同一 rev 内若 at 升序与 record_id 升序不一致，页界会切在中间：上一页尾 id 较大，
 * 下一页 `record_id > 上页尾` 会把 at 更晚、id 更小的行永久挡在外面（水位不回退，永不重读）。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { VectorStore } from "../sqlite.js";

const TENANT = { teamId: "team-cur", userId: "usr-cur", agentId: "agt-cur" };
const PERSON = "p_cur";
const REV = "2026-11-18T00:00:00.000Z";

function insert(dbPath: string, id: string, at: string): void {
  const db = new DatabaseSync(dbPath);
  db.prepare(
    "INSERT INTO l1_records (record_id, content, team_id, user_id, agent_id, created_time, updated_time, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    "内容 " + id,
    TENANT.teamId,
    TENANT.userId,
    TENANT.agentId,
    at,
    REV,
    JSON.stringify({ persons: [{ key: PERSON, role: "subject" }] }),
  );
  db.close();
}

describe("A3 Round8 CP5：listL1ByPerson 游标不漏读", () => {
  it("同一 rev 内 at 与 record_id 反序时，逐页仍能读完", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l1-cur-"));
    const dbPath = path.join(dir, "vectors.db");
    const store = new VectorStore(dbPath, 0);
    const initRes = store.init();
    if (store.isDegraded()) throw new Error("临时库初始化降级：" + initRes.reason);
    try {
      // r2 的 at 更早、r1 更晚：按 at 排是 [r2, r1]，按 id 排是 [r1, r2]。
      insert(dbPath, "r2", "2026-11-17T00:00:01.000Z");
      insert(dbPath, "r1", "2026-11-17T00:00:02.000Z");
      const seen: string[] = [];
      let after: string | undefined;
      let afterRecordId: string | undefined;
      for (let page = 0; page < 5; page += 1) {
        const rows = store.listL1ByPerson(TENANT, PERSON, 1, { updatedAfter: after ?? "", ...(afterRecordId !== undefined ? { afterRecordId } : {}) });
        if (rows.length === 0) break;
        const row = rows[0]!;
        seen.push(String(row.recordId));
        after = String(row.updatedAt ?? "");
        afterRecordId = String(row.recordId);
      }
      expect(seen.sort()).toEqual(["r1", "r2"]);
    } finally {
      try {
        store.close?.();
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 句柄回收延迟不影响断言 */
      }
    }
  });
});