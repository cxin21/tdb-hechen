import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendRecallJournal, recallJournalFileName } from "../recall-journal.js";

/**
 * 任务5（用户 2026-09-22 拍板定案）：召回/灵魂注入日志系统——writer 轮转 RED。
 * 采集点=performLayeredRecall 返回点单一源（两路共用）；writer best-effort 失败零影响主链路；
 * 存储=<dataDir>/logs/recall/ 按租户 recall-journal-{team}-{agent}.jsonl，大小轮转 5MB×5 全可配。
 */
const base = {
  ts: "2026-09-22T00:00:00.000Z", query: "q", strategy: "hybrid",
  teamId: "team-a", userId: "u", agentId: "agt-a", sessionKey: "sess-1",
  sessionReused: false, layered: true,
  conclusionCount: 1, experienceCount: 2,
  searchTiming: { ftsMs: 1, embeddingMs: 2, ftsHits: 3, embeddingHits: 4 },
  block: "<soul-identity></soul-identity>", memoryLines: ["l1"],
};

function linesOf(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

describe("T5: recall-journal writer", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "rj-")); });
  const tenant = { teamId: "team-a", agentId: "agt-a" };
  const opts = { enabled: true, rotationSizeMB: 5, maxFiles: 5 };

  it("append 写入 JSONL 行（租户命名+字段完整）", () => {
    appendRecallJournal(dir, tenant, base as never, opts);
    const rows = linesOf(path.join(dir, "recall-journal-team-a-agt-a.jsonl"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.query).toBe("q");
    expect(rows[0]!.teamId).toBe("team-a");
    expect((rows[0]!.searchTiming as Record<string, unknown>).ftsHits).toBe(3);
  });

  it("disabled → 不写文件（缺省逐位现状）", () => {
    appendRecallJournal(dir, tenant, base as never, { ...opts, enabled: false });
    expect(existsSync(path.join(dir, "recall-journal-team-a-agt-a.jsonl"))).toBe(false);
  });

  it("大小轮转：超限→当前改名 .1，新起当前文件", () => {
    const o = { enabled: true, rotationSizeMB: 0.000005, maxFiles: 5 };
    appendRecallJournal(dir, tenant, base as never, o);
    appendRecallJournal(dir, tenant, base as never, o);
    expect(existsSync(path.join(dir, "recall-journal-team-a-agt-a.1.jsonl"))).toBe(true);
    const cur = readFileSync(path.join(dir, "recall-journal-team-a-agt-a.jsonl"), "utf8").trim().split("\n").filter(Boolean);
    expect(cur).toHaveLength(1);
  });

  it("数量上限：maxFiles=3 → 轮转文件 ≤2 份", () => {
    const o = { enabled: true, rotationSizeMB: 0.000005, maxFiles: 3 };
    for (let i = 0; i < 6; i++) appendRecallJournal(dir, tenant, base as never, o);
    const rotated = [1, 2, 3, 4, 5].filter((n) => existsSync(path.join(dir, `recall-journal-team-a-agt-a.${n}.jsonl`)));
    expect(rotated.length).toBe(2);
  });

  it("租户隔离：不同 team 各自文件", () => {
    appendRecallJournal(dir, tenant, base as never, opts);
    appendRecallJournal(dir, { teamId: "team-b", agentId: "agt-a" }, base as never, opts);
    expect(existsSync(path.join(dir, "recall-journal-team-a-agt-a.jsonl"))).toBe(true);
    expect(existsSync(path.join(dir, "recall-journal-team-b-agt-a.jsonl"))).toBe(true);
  });

  it("best-effort：目录不可用（路径为文件）→ 不抛异常", () => {
    const blocker = path.join(dir, "not-a-dir");
    writeFileSync(blocker, "x");
    expect(() => appendRecallJournal(blocker, tenant, base as never, opts)).not.toThrow();
  });
});
