import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";
import {
  SOUL_INJECTION_STATS_PATH,
  handleSoulInjectionStatsRoute,
} from "../soul-injection-stats-endpoint.js";
import { recallJournalFileName } from "../../core/recall/recall-journal.js";

const res = {} as ServerResponse;
const NOW = new Date("2026-11-07T12:00:00.000Z");
const ENABLED = { enabled: true, rotationSizeMB: 5, maxFiles: 5 };
const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "soul-injection-stats-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeJournal(dir: string, team: string, agent: string, rows: unknown[], suffix = ""): string {
  const base = recallJournalFileName({ teamId: team, agentId: agent });
  const name = suffix === "" ? base : `${base.slice(0, -".jsonl".length)}${suffix}.jsonl`;
  const file = path.join(dir, name);
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
  return file;
}

function isoMinutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

function injection(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: "injection",
    ts: isoMinutesAgo(5),
    teamId: "t1",
    agentId: "a1",
    sessionKey: "s1",
    turn: 1,
    ...overrides,
  };
}

function recall(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    ts: isoMinutesAgo(6),
    teamId: "t1",
    agentId: "a1",
    sessionKey: "s1",
    query: "q",
    strategy: "layered",
    sessionReused: false,
    layered: false,
    conclusionCount: 0,
    experienceCount: 0,
    searchTiming: { ftsMs: 0, embeddingMs: 0, ftsHits: 0, embeddingHits: 0 },
    memoryLines: [],
    ...overrides,
  };
}

function call(url: string, method = "GET", journalDir = tmpDir(), opts = ENABLED) {
  const sendJson = vi.fn();
  return handleSoulInjectionStatsRoute(new URL(url, "http://localhost"), method, sendJson, res, {
    journalDir,
    journalOpts: opts,
    now: () => NOW,
  }).then((handled) => ({ handled, sendJson }));
}

describe("GET /v3/soul/injection/stats（P0-D 注入健康面）", () => {
  it("只认本路径：其余交回 dispatch", async () => {
    expect((await call("/v3/soul/injection")).handled).toBe(false);
    expect((await call("/v3/soul/card")).handled).toBe(false);
  });

  it("缺 team → 400 missing_team；hours 非法 → 400 bad_hours", async () => {
    const missing = await call(SOUL_INJECTION_STATS_PATH);
    expect(missing.sendJson.mock.calls[0]?.[1]).toBe(400);
    expect(missing.sendJson.mock.calls[0]?.[2]).toMatchObject({ message: "missing_team" });

    const bad = await call(`${SOUL_INJECTION_STATS_PATH}?team=t1&hours=0`);
    expect(bad.sendJson.mock.calls[0]?.[1]).toBe(400);
    expect(bad.sendJson.mock.calls[0]?.[2]).toMatchObject({ message: "bad_hours" });
  });

  it("非 GET → 405（与注入端点同码）", async () => {
    const { handled, sendJson } = await call(`${SOUL_INJECTION_STATS_PATH}?team=t1`, "POST");
    expect(handled).toBe(true);
    expect(sendJson.mock.calls[0]?.[1]).toBe(405);
    expect(sendJson.mock.calls[0]?.[2]).toMatchObject({ message: "method_not_allowed" });
  });

  it("journal 关闭或目录不存在 → 200 + 全零 + note=journal_disabled", async () => {
    const disabled = await call(`${SOUL_INJECTION_STATS_PATH}?team=t1`, "GET", tmpDir(), {
      ...ENABLED,
      enabled: false,
    });
    expect(disabled.sendJson.mock.calls[0]?.[1]).toBe(200);
    const data = (disabled.sendJson.mock.calls[0]?.[2] as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({
      rows: 0,
      lastAt: null,
      lastCard: null,
      lastVolatile: null,
      serverRenderOnly: 0,
      pairs: { matched: 0, charMismatch: 0 },
      note: "journal_disabled",
    });

    const noDir = await call(`${SOUL_INJECTION_STATS_PATH}?team=t1`, "GET", path.join(tmpDir(), "absent"));
    expect((noDir.sendJson.mock.calls[0]?.[2] as { data: { note?: string } }).data.note).toBe("journal_disabled");
  });

  it("空目录（journal 开启、无文件）→ 200 且不冒充 0：last* 与 failReasons 均为 null", async () => {
    const { sendJson } = await call(`${SOUL_INJECTION_STATS_PATH}?team=t1&agent=a1`, 'GET', tmpDir());
    const data = (sendJson.mock.calls[0]?.[2] as { data: Record<string, unknown> }).data;
    expect(data.rows).toBe(0);
    expect(data.lastAt).toBeNull();
    expect(data.lastCard).toBeNull();
    expect(data.lastVolatile).toBeNull();
    expect(data.volatileCounts).toEqual({ injected: 0, skipped: 0 });
    expect(data.failReasons).toBeNull();
    expect(data.note).toBeUndefined();
    expect(data.window).toMatchObject({ hours: 24 });
  });

  it("正常聚合：最近时间/两条通道元数据/对账缺口/失败分类", async () => {
    const dir = tmpDir();
    writeJournal(dir, "t1", "a1", [
      injection({ ts: isoMinutesAgo(30), card: { version: 5, hash: "h5", chars: 900 } }),
      injection({ ts: isoMinutesAgo(20), volatile: { chars: 52, hash: "v1", skipped: false } }),
      injection({
        ts: isoMinutesAgo(5),
        sessionKey: "s2",
        volatile: { chars: 0, hash: "v1", skipped: true },
      }),
      injection({ ts: isoMinutesAgo(3), sessionKey: "s2", failReason: "timeout" }),
      injection({ ts: isoMinutesAgo(2), sessionKey: "s2", failReason: "timeout" }),
      injection({ ts: isoMinutesAgo(1), sessionKey: "s2", failReason: "parse" }),
      // 窗口外（30 小时前）
      injection({ ts: isoMinutesAgo(30 * 60), card: { version: 1, hash: "old", chars: 1 } }),
      // 别的租户 / 别的 user
      injection({ ts: isoMinutesAgo(4), teamId: "t2" }),
      injection({ ts: isoMinutesAgo(4), userId: "u2" }),
    ]);
    writeJournal(dir, "t1", "a1", [
      recall({ ts: isoMinutesAgo(31), soul: { sessionInit: { version: 5, hash: "h5", chars: 900 }, turnChars: 52 } }),
      recall({ ts: isoMinutesAgo(4), sessionKey: "s2", soul: { turnChars: 52 } }),
      recall({ ts: isoMinutesAgo(3), sessionKey: "s3", soul: { turnChars: 40, source: "server-render" } }),
    ], ".1");

    const { sendJson } = await call(`${SOUL_INJECTION_STATS_PATH}?team=t1&agent=a1&user=u1`, 'GET', dir);
    expect(sendJson.mock.calls[0]?.[1]).toBe(200);
    const data = (sendJson.mock.calls[0]?.[2] as { data: Record<string, unknown> }).data;
    expect(data.rows).toBe(6); // 窗口内 t1/a1/u1 的注入行（含失败行）
    expect(data.lastAt).toBe(isoMinutesAgo(1));
    expect(data.lastCard).toEqual({ version: 5, hash: "h5", chars: 900 });
    expect(data.lastVolatile).toEqual({ chars: 0, hash: "v1", skipped: true });
    // 窗口内 3 条 volatile 行：1 条真追加、1 条被去重跳过、1 条是失败行（无 volatile，不计）。
    expect(data.volatileCounts).toEqual({ injected: 1, skipped: 1 });
    expect(data.failReasons).toEqual({ http_status: 0, timeout: 2, empty: 0, parse: 1 });
    // s1 匹配且卡/turnChars 都对上；s2 对上了但 recall 52 vs 实际 0 → charMismatch；s3 只有召回。
    expect(data.pairs).toEqual({ matched: 2, charMismatch: 1 });
    expect(data.serverRenderOnly).toBe(1);
  });

  it("skipped 行：lastVolatile.skipped=true 且 chars=0（不是被跳过的原文字节数）", async () => {
    const dir = tmpDir();
    writeJournal(dir, "t1", "a1", [
      injection({ ts: isoMinutesAgo(9), volatile: { chars: 52, hash: "v1", skipped: false } }),
      injection({ ts: isoMinutesAgo(2), volatile: { chars: 0, hash: "v1", skipped: true } }),
    ]);
    const { sendJson } = await call(`${SOUL_INJECTION_STATS_PATH}?team=t1&agent=a1`, 'GET', dir);
    const data = (sendJson.mock.calls[0]?.[2] as { data: Record<string, unknown> }).data;
    expect(data.lastVolatile).toEqual({ chars: 0, hash: "v1", skipped: true });
    // 面板「去重跳过 N 次」的聚合口径：这一对就是 1 次真注入 + 1 次跳过。
    expect(data.volatileCounts).toEqual({ injected: 1, skipped: 1 });
  });

  it("hours 收窄窗口：更早的注入行不计入 rows/last*", async () => {
    const dir = tmpDir();
    writeJournal(dir, "t1", "a1", [
      injection({ ts: isoMinutesAgo(180), card: { version: 2, hash: "h2", chars: 10 } }),
      injection({ ts: isoMinutesAgo(30), card: { version: 3, hash: "h3", chars: 20 } }),
    ]);
    const { sendJson } = await call(`${SOUL_INJECTION_STATS_PATH}?team=t1&agent=a1&hours=1`, 'GET', dir);
    const data = (sendJson.mock.calls[0]?.[2] as { data: Record<string, unknown> }).data;
    expect(data.rows).toBe(1);
    expect(data.lastCard).toEqual({ version: 3, hash: "h3", chars: 20 });
    expect(data.window).toMatchObject({ hours: 1 });
  });

  it("坏行与空行被跳过，不影响其它行的聚合", async () => {
    const dir = tmpDir();
    const file = writeJournal(dir, "t1", "a1", [injection({ card: { version: 1, hash: "h1", chars: 5 } })]);
    fs.appendFileSync(file, "{not json\n\n" + JSON.stringify(injection({ ts: "", card: null })) + "\n", "utf8");
    const { sendJson } = await call(`${SOUL_INJECTION_STATS_PATH}?team=t1&agent=a1`, 'GET', dir);
    const data = (sendJson.mock.calls[0]?.[2] as { data: Record<string, unknown> }).data;
    expect(data.rows).toBe(1);
    expect(data.lastCard).toEqual({ version: 1, hash: "h1", chars: 5 });
  });

  it("端到端证据：64 hex 卡 hash 与召回 sessionInit.hash 相等 → pairStrategy=hash、proof 计入", async () => {
    const dir = tmpDir();
    const textHash = "a".repeat(64);
    writeJournal(dir, "t1", "a1", [
      injection({ ts: isoMinutesAgo(5), card: { version: 7, hash: textHash, chars: 1200 } }),
    ]);
    writeJournal(dir, "t1", "a1", [
      recall({ ts: isoMinutesAgo(6), soul: { sessionInit: { version: 7, hash: textHash, chars: 1200 } } }),
    ], ".1");
    const { sendJson } = await call(`${SOUL_INJECTION_STATS_PATH}?team=t1&agent=a1`, "GET", dir);
    const data = (sendJson.mock.calls[0]?.[2] as { data: Record<string, unknown> }).data;
    expect(data.pairStrategy).toBe("hash");
    expect(data.pairs).toEqual({ matched: 1, charMismatch: 0 });
    expect(data.proof).toEqual({ sectionReadCount: 1, textHashMatched: 1, sessionsWithProof: 1 });
  });

  it("旧行不报错：8 hex 或无 hash 的卡行只算 sectionReadCount，不冒充 SHA-256 证据", async () => {
    const dir = tmpDir();
    writeJournal(dir, "t1", "a1", [
      injection({ ts: isoMinutesAgo(5), card: { version: 3, hash: "abcd1234", chars: 40 } }),
      injection({ ts: isoMinutesAgo(4), sessionKey: "s2", card: { version: 3, hash: "", chars: 40 } }),
      injection({ ts: isoMinutesAgo(3), sessionKey: "s2", volatile: { chars: 12, hash: "v1", skipped: false } }),
    ]);
    const { sendJson } = await call(`${SOUL_INJECTION_STATS_PATH}?team=t1&agent=a1`, "GET", dir);
    expect(sendJson.mock.calls[0]?.[1]).toBe(200);
    const data = (sendJson.mock.calls[0]?.[2] as { data: Record<string, unknown> }).data;
    expect(data.rows).toBe(3);
    expect(data.proof).toEqual({ sectionReadCount: 1, textHashMatched: 0, sessionsWithProof: 0 });
    expect(data.pairStrategy).toBe("chars");
  });
});
