/**
 * #84 —— backfill-l0-classification 测试（UPDATE-only，零删除，零内容改写）。
 *
 * 先例：src/core/lifecycle/__tests__/backfill-theme-aliases.test.ts（导出纯函数 core + fake 依赖注入）。
 * 覆盖：决策矩阵（real/scaffold/探针覆写/artifact/echo/unknown）、dry-run 零写、write 生效、
 * 行数不变、非 classification 列不变、已分类行与 assistant 行不动、幂等重跑、--limit、指纹断言可抓越权改动。
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  classifyL0Row,
  runBackfillL0Classification,
  type L0BackfillDb,
} from "../scripts/backfill-l0-classification.js";

const PROBE_TEXT = "探针消息：验证 L0 写入链路，本条可安全忽略。";

const FIXTURES = {
  cjkQuestion: "这个仓库的召回链路是怎么实现的？",
  compressedHead: "[Compressed conversation section]\nm00001–m00010 摘要",
  probe: PROBE_TEXT,
  enQuestion: "how does the recall pipeline work in this repo?",
  xmlArtifact: "<system_warning>disk almost full</system_warning>",
  lowercaseEcho: "ok",
  mixedCaps: "OK Whatever Mixed Case No Question Mark",
} as const;

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function mkDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(
    [
      "CREATE TABLE l0_conversations (",
      "  record_id TEXT PRIMARY KEY,",
      "  session_key TEXT NOT NULL DEFAULT '',",
      "  session_id TEXT DEFAULT '',",
      "  team_id TEXT DEFAULT '',",
      "  task_id TEXT DEFAULT '',",
      "  user_id TEXT DEFAULT '',",
      "  agent_id TEXT DEFAULT '',",
      "  role TEXT NOT NULL DEFAULT '',",
      "  message_text TEXT NOT NULL,",
      "  recorded_at TEXT DEFAULT '',",
      "  timestamp INTEGER,",
      "  classification TEXT NOT NULL DEFAULT 'unclassified'",
      ")",
    ].join("\n"),
  );
  return db;
}

function insertRow(db: DatabaseSync, recordId: string, role: string, text: string, classification = "unclassified"): void {
  db.prepare(
    "INSERT INTO l0_conversations (record_id, session_key, role, message_text, recorded_at, timestamp, classification) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(recordId, "s1", role, text, "2026-10-25T00:00:00Z", 1761350000000, classification);
}

function readClass(db: DatabaseSync, recordId: string): string {
  return (db.prepare("SELECT classification FROM l0_conversations WHERE record_id=?").get(recordId) as { classification: string }).classification;
}

/** 全表快照（默认含 classification；exclude=true 时剔除，用于验证他列逐行不变） */
function snapAll(db: DatabaseSync, excludeClassification = false): Record<string, Record<string, unknown>> {
  const rows = db.prepare("SELECT * FROM l0_conversations ORDER BY record_id").all() as Array<Record<string, unknown>>;
  const out: Record<string, Record<string, unknown>> = {};
  for (const r of rows) {
    const copy: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      if (excludeClassification && k === "classification") continue;
      copy[k] = v;
    }
    out[String(r.record_id)] = copy;
  }
  return out;
}

describe("backfill-l0-classification（#84）", () => {
  it("classifyL0Row 决策矩阵：探针覆写 scaffold，其余走分类器单一事实源", () => {
    expect(classifyL0Row(FIXTURES.cjkQuestion)).toEqual({ classification: "real", reason: "classifier" });
    expect(classifyL0Row(FIXTURES.compressedHead)).toEqual({ classification: "scaffold", reason: "classifier" });
    expect(classifyL0Row(FIXTURES.probe)).toEqual({ classification: "scaffold", reason: "probe-override" });
    // 引用探针句的压缩摘要 ≠ 历史测试行本身：走分类器（同为 scaffold，reason 不误归因）
    expect(classifyL0Row("[Compressed conversation section]\n（探针消息：验证 L0 写入链路，本条可安全忽略。已删）")).toEqual({ classification: "scaffold", reason: "classifier" });
    expect(classifyL0Row(FIXTURES.enQuestion)).toEqual({ classification: "real", reason: "classifier" });
    expect(classifyL0Row(FIXTURES.xmlArtifact)).toEqual({ classification: "artifact", reason: "classifier" });
    expect(classifyL0Row(FIXTURES.lowercaseEcho)).toEqual({ classification: "echo", reason: "classifier" });
    expect(classifyL0Row(FIXTURES.mixedCaps)).toEqual({ classification: "unknown", reason: "classifier" });
  });

  it("dry-run：零写，仅产出计划与分布", async () => {
    const db = mkDb();
    insertRow(db, "u1", "user", FIXTURES.cjkQuestion);
    insertRow(db, "u2", "user", FIXTURES.probe);
    insertRow(db, "a1", "assistant", "回答文本");
    const r = await runBackfillL0Classification({ db, write: false, logger: silentLogger });
    expect(r.mode).toBe("dry-run");
    expect(r.targets).toBe(2);
    expect(r.updated).toBe(0);
    expect(r.plan.map((p) => [p.recordId, p.classification, p.reason])).toEqual([
      ["u1", "real", "classifier"],
      ["u2", "scaffold", "probe-override"],
    ]);
    expect(readClass(db, "u1")).toBe("unclassified");
    expect(readClass(db, "u2")).toBe("unclassified");
    expect(readClass(db, "a1")).toBe("unclassified");
    expect(r.assertOk).toBe(true);
  });

  it("write：分类写入生效，行数不变，message_text 等他列逐行不变", async () => {
    const db = mkDb();
    insertRow(db, "u1", "user", FIXTURES.cjkQuestion);
    insertRow(db, "u2", "user", FIXTURES.compressedHead);
    insertRow(db, "u3", "user", FIXTURES.probe);
    insertRow(db, "u4", "user", FIXTURES.enQuestion);
    insertRow(db, "u5", "user", FIXTURES.xmlArtifact);
    const before = snapAll(db, true);
    const r = await runBackfillL0Classification({ db, write: true, logger: silentLogger });
    expect(r.mode).toBe("write");
    expect(r.targets).toBe(5);
    expect(r.updated).toBe(5);
    expect(r.beforeCount).toBe(5);
    expect(r.afterCount).toBe(5);
    expect(readClass(db, "u1")).toBe("real");
    expect(readClass(db, "u2")).toBe("scaffold");
    expect(readClass(db, "u3")).toBe("scaffold");
    expect(readClass(db, "u4")).toBe("real");
    expect(readClass(db, "u5")).toBe("artifact");
    expect(snapAll(db, true)).toEqual(before);
    expect(r.fingerprintBefore).toBe(r.fingerprintAfter);
    expect(r.distributionUser).toEqual({ real: 2, scaffold: 2, artifact: 1 });
    expect(r.assertOk).toBe(true);
    expect(r.assertionFailures).toEqual([]);
  });

  it("已分类行与 assistant 行不进目标、不被动", async () => {
    const db = mkDb();
    insertRow(db, "u1", "user", PROBE_TEXT, "real");
    insertRow(db, "a1", "assistant", PROBE_TEXT);
    insertRow(db, "u2", "user", FIXTURES.cjkQuestion);
    const before = snapAll(db, true);
    const r = await runBackfillL0Classification({ db, write: true, logger: silentLogger });
    expect(r.targets).toBe(1);
    expect(readClass(db, "u1")).toBe("real");
    expect(readClass(db, "a1")).toBe("unclassified");
    expect(readClass(db, "u2")).toBe("real");
    expect(snapAll(db, true)).toEqual(before);
  });

  it("幂等：重跑目标为 0，分布不变", async () => {
    const db = mkDb();
    insertRow(db, "u1", "user", FIXTURES.cjkQuestion);
    await runBackfillL0Classification({ db, write: true, logger: silentLogger });
    const r2 = await runBackfillL0Classification({ db, write: true, logger: silentLogger });
    expect(r2.targets).toBe(0);
    expect(r2.updated).toBe(0);
    expect(r2.distributionUser).toEqual({ real: 1 });
    expect(r2.assertOk).toBe(true);
  });

  it("--limit：只处理前 N 行", async () => {
    const db = mkDb();
    insertRow(db, "u1", "user", FIXTURES.cjkQuestion);
    insertRow(db, "u2", "user", FIXTURES.probe);
    const r = await runBackfillL0Classification({ db, write: true, limit: 1, logger: silentLogger });
    expect(r.targets).toBe(1);
    expect(r.plan[0].recordId).toBe("u1");
    expect(readClass(db, "u2")).toBe("unclassified");
  });

  it("指纹断言能抓住非 classification 列的越权改动", async () => {
    const base = mkDb();
    insertRow(base, "u1", "user", FIXTURES.cjkQuestion);
    let fingerprintReads = 0;
    const db: L0BackfillDb = {
      exec: (sql: string) => base.exec(sql),
      prepare: (sql: string) => {
        const st = base.prepare(sql);
        return {
          all: (...p: unknown[]) => {
            if (sql.startsWith("SELECT record_id, session_key")) {
              fingerprintReads++;
              if (fingerprintReads === 2) {
                base.prepare("UPDATE l0_conversations SET message_text=? WHERE record_id=?").run("被越权改写", "u1");
              }
            }
            return st.all(...(p as never[]));
          },
          run: (...p: unknown[]) => st.run(...(p as never[])),
        };
      },
    };
    const r = await runBackfillL0Classification({ db, write: true, logger: silentLogger });
    expect(r.assertOk).toBe(false);
    expect(r.assertionFailures.some((f) => f.includes("指纹"))).toBe(true);
  });
});
