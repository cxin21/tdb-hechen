/**
 * 缺口 A · soul_snapshots 版本链（真实 sqlite store）RED 套件。
 *
 * 合同（DB 形态变更点）：
 *  - 增列 version INTEGER（该 tenant 维度单调递增，从 1 起）/ parent_hash TEXT / reason_detail TEXT /
 *    slots_json TEXT；原 trigger 列语义升级为 reason_code（受控枚举，见 soul-versioning.ts）。
 *  - 首版 version=1、parent_hash=NULL；第二版 version=2、parent_hash=上一版 content_hash。
 *  - 内容未变（content_hash 相同）→ 零落行（幂等，不刷版本号）。
 *  - readLastSoulSnapshot 回整行（含 version/parent_hash/slots_json）。
 *  - 老库（无新列）init 幂等补列；旧行 version=0，新写入从 count+1 续号（不撞号、不丢历史）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { VectorStore } from "../sqlite.js";

const T = { teamId: "t1", userId: "u1", agentId: "a1" };
const T2 = { teamId: "t2", userId: "u2", agentId: "a2" };

async function withStore(fn: (store: VectorStore) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "soul-snap-ver-"));
  const store = new VectorStore(join(dir, "vectors.db"), 0);
  try {
    await store.init();
    await fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("A · soul_snapshots 版本链", () => {
  it("listSoulSnapshots(limit) 取最近 N 条（升序窗口落在末端），不是最早 N 条", async () => {
    await withStore((store) => {
      for (let i = 1; i <= 5; i++) {
        store.writeSoulSnapshot!(T2, {
          ts: `2026-11-0${i}T00:00:00.000Z`,
          contentHash: `h${i}`,
          payloadJson: `渲染${i}`,
          reasonCode: "identity-discovery",
        });
      }
      const all = store.listSoulSnapshots!(T2);
      expect(all.map((r) => r.content_hash)).toEqual(["h1", "h2", "h3", "h4", "h5"]);
      // 生产 soul_snapshots 有 1619 行：默认窗口必须落在末端，否则面板"版本链"
      // 只能看到最初几次渲染，最近变更一次都看不到（复核 P2）。
      const tail = store.listSoulSnapshots!(T2, 2);
      expect(tail.map((r) => r.content_hash)).toEqual(["h4", "h5"]);
      expect(tail.map((r) => r.version)).toEqual([4, 5]);
    });
  });


  it("首版 version=1 parent_hash=NULL；同内容幂等零落行；第二版 version=2 且 parent_hash=首版 hash", async () => {
    await withStore((store) => {
      store.writeSoulSnapshot!(T, {
        ts: "2026-11-01T00:00:00.000Z",
        contentHash: "h1",
        payloadJson: "渲染一",
        reasonCode: "first-version",
        slotsJson: JSON.stringify({ "slot:self_identity": "s1" }),
      });
      let rows = store.listSoulSnapshots!(T);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.version).toBe(1);
      expect(rows[0]!.parent_hash).toBeNull();
      expect(rows[0]!.trigger).toBe("first-version");

      // 幂等：同 content_hash 再写（时间不同）→ 不新增、不刷版本号
      store.writeSoulSnapshot!(T, {
        ts: "2026-11-01T01:00:00.000Z",
        contentHash: "h1",
        payloadJson: "渲染一",
        reasonCode: "layout",
      });
      rows = store.listSoulSnapshots!(T);
      expect(rows).toHaveLength(1);

      store.writeSoulSnapshot!(T, {
        ts: "2026-11-02T00:00:00.000Z",
        contentHash: "h2",
        payloadJson: "渲染二",
        reasonCode: "identity-discovery",
        reasonDetail: "keys=slot:self_identity",
        slotsJson: JSON.stringify({ "slot:self_identity": "s2" }),
      });
      rows = store.listSoulSnapshots!(T);
      expect(rows).toHaveLength(2);
      expect(rows[1]!.version).toBe(2);
      expect(rows[1]!.parent_hash).toBe("h1");
      expect(rows[1]!.trigger).toBe("identity-discovery");
      expect(rows[1]!.reason_detail).toBe("keys=slot:self_identity");
    });
  });

  it("readLastSoulSnapshot 回整行；空库为 null；租户/agent 维度各自从 1 起", async () => {
    await withStore((store) => {
      expect(store.readLastSoulSnapshot!(T)).toBeNull();
      store.writeSoulSnapshot!(T, {
        ts: "2026-11-01T00:00:00.000Z",
        contentHash: "a",
        payloadJson: "p",
        reasonCode: "first-version",
      });
      store.writeSoulSnapshot!(T2, {
        ts: "2026-11-01T00:00:00.000Z",
        contentHash: "z",
        payloadJson: "q",
        reasonCode: "first-version",
      });
      const last = store.readLastSoulSnapshot!(T);
      expect(last?.content_hash).toBe("a");
      expect(last?.version).toBe(1);
      expect(last?.parent_hash).toBeNull();
      expect(store.listSoulSnapshots!(T2)[0]!.version).toBe(1);
      expect(store.readLastSoulSnapshotHash!(T)).toBe("a");
    });
  });

  it("老库迁移：init 幂等补列，旧行 version=0 可读，新写入续号（count+1）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "soul-snap-legacy-"));
    const dbPath = join(dir, "vectors.db");
    try {
      const raw = new DatabaseSync(dbPath);
      raw.exec(`CREATE TABLE soul_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        team_id TEXT NOT NULL DEFAULT 'default',
        user_id TEXT NOT NULL DEFAULT 'default',
        agent_id TEXT NOT NULL DEFAULT 'default',
        ts TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        "trigger" TEXT NOT NULL DEFAULT 'render'
      )`);
      raw
        .prepare(
          "INSERT INTO soul_snapshots (team_id,user_id,agent_id,ts,content_hash,payload_json) VALUES (?,?,?,?,?,?)",
        )
        .run(T.teamId, T.userId, T.agentId, "2026-10-01T00:00:00.000Z", "old1", "旧渲染");
      raw.close();

      const store = new VectorStore(dbPath, 0);
      await store.init();
      try {
        const legacy = store.listSoulSnapshots!(T);
        expect(legacy).toHaveLength(1);
        expect(legacy[0]!.version).toBe(0);
        expect(legacy[0]!.parent_hash).toBeNull();

        store.writeSoulSnapshot!(T, {
          ts: "2026-11-01T00:00:00.000Z",
          contentHash: "new1",
          payloadJson: "新渲染",
          reasonCode: "identity-discovery",
        });
        const rows = store.listSoulSnapshots!(T);
        expect(rows).toHaveLength(2);
        expect(rows[1]!.version).toBe(2);
        expect(rows[1]!.parent_hash).toBe("old1");
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
