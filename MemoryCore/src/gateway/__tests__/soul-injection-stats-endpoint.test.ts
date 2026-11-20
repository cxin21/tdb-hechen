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
    expect(data.lastCard).toEqual({ version: 5, textHash: "h5", chars: 900 });
    expect(data.lastVolatile).toEqual({ chars: 0, hash: "v1", skipped: true });
    // 窗口内 3 条 volatile 行：1 条真追加、1 条被去重跳过、1 条是失败行（无 volatile，不计）。
    expect(data.volatileCounts).toEqual({ injected: 1, skipped: 1 });
    expect(data.failReasons).toEqual({ http_status: 0, timeout: 2, empty: 0, parse: 1, section_install_failed: 0 });

    // A4 Round10（CP1）：段注册失败是合法失败行——不能被当成空行丢掉，
    // 也不新增 byReason 桶（归 other），lastFailure.reason 保留原文。
    const dir2 = tmpDir();
    writeJournal(dir2, "t1", "a1", [
      injection({ ts: isoMinutesAgo(2), sessionKey: "s9", failReason: "section_install_failed" }),
    ]);
    const second = await call(`${SOUL_INJECTION_STATS_PATH}?team=t1&agent=a1&user=u1`, 'GET', dir2);
    const d2 = (second.sendJson.mock.calls[0]?.[2] as { data: Record<string, unknown> }).data;
    // 它是合法注入行（rows 计入）；Round11 起段注册失败在 failReasons 里单列一桶，
    // 只统计插件本地日志的四类取卡失败的 byReason 才把它归 other（A4 复核 R1）。
    expect(d2.rows).toBe(1);
    expect(d2.failReasons).toEqual({ http_status: 0, timeout: 0, empty: 0, parse: 0, section_install_failed: 1 });
    expect((d2.plugin as { byReason: Record<string, number> }).byReason.other).toBe(0);
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
    expect(data.lastCard).toEqual({ version: 3, textHash: "h3", chars: 20 });
    expect(data.window).toMatchObject({ hours: 1 });
  });

  it("坏行与空行被跳过，不影响其它行的聚合", async () => {
    const dir = tmpDir();
    const file = writeJournal(dir, "t1", "a1", [injection({ card: { version: 1, hash: "h1", chars: 5 } })]);
    fs.appendFileSync(file, "{not json\n\n" + JSON.stringify(injection({ ts: "", card: null })) + "\n", "utf8");
    const { sendJson } = await call(`${SOUL_INJECTION_STATS_PATH}?team=t1&agent=a1`, 'GET', dir);
    const data = (sendJson.mock.calls[0]?.[2] as { data: Record<string, unknown> }).data;
    expect(data.rows).toBe(1);
    expect(data.lastCard).toEqual({ version: 1, textHash: "h1", chars: 5 });
  });

  // 合成口径（正控）：两侧 hash 人为相等才计 1。生产里 card.hash=sha256(整卡 text)、
  // 召回 hash=sha256(material)，定义不同，textHashMatched 应为 0——不要把这个用例当交付证据。
  it("同会话 card.hash 与 sessionInit.hash 逐字相等（合成口径）→ pairStrategy=hash、textHashMatched 计入；生产应为 0", async () => {
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
    // Round28（r28c-a4）：proof 不再比「召回 sessionInit.hash」，改比「段行 cardHash vs 绑定行 card.hash」。
    // 这一例没有插件段行，所以是 0——旧断言把两套定义相等当证据，正产也因此结构性恒 0。
    expect(data.proof).toEqual({ sectionReadCount: 1, textHashMatched: 0, sessionsWithProof: 0, sectionCardHashCount: 0 });
  });

  it("真实口径：卡 hash（sha256(text)）与召回 hash（sha256(material)）不同 → pairStrategy=chars，不冒充 hash 证据", async () => {
    const dir = tmpDir();
    const cardHash = "b".repeat(64);
    const recallHash = "c".repeat(64);
    writeJournal(dir, "t1", "a1", [
      injection({ ts: isoMinutesAgo(5), card: { version: 7, hash: cardHash, chars: 1200 } }),
    ]);
    writeJournal(dir, "t1", "a1", [
      recall({ ts: isoMinutesAgo(6), soul: { sessionInit: { version: 7, hash: recallHash, chars: 1200 } } }),
    ], ".1");
    const { sendJson } = await call(`${SOUL_INJECTION_STATS_PATH}?team=t1&agent=a1`, "GET", dir);
    const data = (sendJson.mock.calls[0]?.[2] as { data: Record<string, unknown> }).data;
    expect(cardHash).not.toBe(recallHash);
    expect(data.pairStrategy).toBe("chars");
    expect(data.proof).toEqual({ sectionReadCount: 1, textHashMatched: 0, sessionsWithProof: 0, sectionCardHashCount: 0 });
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
    expect(data.proof).toEqual({ sectionReadCount: 1, textHashMatched: 0, sessionsWithProof: 0, sectionCardHashCount: 0 });
    expect(data.pairStrategy).toBe("chars");
  });

  it("v2：默认排除 *-test / *-key 身份的 journal 行，并把被排除行数报出来", async () => {
    const dir = tmpDir();
    writeJournal(dir, "t1", "a1", [
      injection({ ts: isoMinutesAgo(5), sessionKey: "s-ok" }),
      injection({ ts: isoMinutesAgo(3), userId: "u1-test" }),
      injection({ ts: isoMinutesAgo(2), userId: "u1-key" }),
    ]);
    writeJournal(dir, "team-test", "a1", [injection({ ts: isoMinutesAgo(4), teamId: "team-test" })]);
    const def = await call(`${SOUL_INJECTION_STATS_PATH}?team=t1&agent=a1`, "GET", dir);
    const defData = (def.sendJson.mock.calls[0]?.[2] as { data: Record<string, unknown> }).data;
    expect(defData.rows).toBe(1);
    expect(defData.excluded).toEqual({ testRows: 2 });

    const wide = await call(`${SOUL_INJECTION_STATS_PATH}?team=t1&agent=a1&includeTest=1`, "GET", dir);
    const wideData = (wide.sendJson.mock.calls[0]?.[2] as { data: Record<string, unknown> }).data;
    expect(wideData.rows).toBe(3);
    expect(wideData.excluded).toEqual({ testRows: 2 });

    // team 维度同样按 -test 后缀排除：那一条不是「租户不匹配」，而是被测试身份过滤，所以要计数。
    const testTeam = await call(`${SOUL_INJECTION_STATS_PATH}?team=team-test&agent=a1`, "GET", dir);
    const testData = (testTeam.sendJson.mock.calls[0]?.[2] as { data: Record<string, unknown> }).data;
    expect(testData.rows).toBe(0);
    expect(testData.excluded).toEqual({ testRows: 1 });
  });

  it("v2：plugin 聚合把 card-bound-failed 按 reason 计数（含轮转文件、按 identity 过滤、窗口外不计）", async () => {
    const dir = tmpDir();
    const pluginPath = path.join(dir, "persona-injection.jsonl");
    const line = (row: Record<string, unknown>) => JSON.stringify(row);
    fs.writeFileSync(
      pluginPath,
      [
        line({ ts: isoMinutesAgo(5), event: "card-bound", identity: "t1/u1/a1", chars: 600 }),
        line({ ts: isoMinutesAgo(4), event: "card-bound-failed", identity: "t1/u1/a1", reason: "timeout", keptVersion: 3 }),
        line({ ts: isoMinutesAgo(3), event: "card-bound-failed", identity: "t1/u1/a1", reason: "http_status" }),
        line({ ts: isoMinutesAgo(2), event: "card-bound-failed", identity: "team-test/u1/a1", reason: "empty" }),
        line({ ts: isoMinutesAgo(1), event: "card-bound-failed", identity: "t1/u1/a2", reason: "parse" }),
      ].join("\n") + "\n",
      "utf8",
    );
    fs.writeFileSync(
      `${pluginPath}.1`,
      line({ ts: isoMinutesAgo(30 * 60), event: "card-bound-failed", identity: "t1/u1/a1", reason: "timeout" }) + "\n",
      "utf8",
    );

    const sendJson = vi.fn();
    await handleSoulInjectionStatsRoute(new URL(`${SOUL_INJECTION_STATS_PATH}?team=t1&user=u1&agent=a1`, "http://localhost"), "GET", sendJson, res, {
      journalDir: dir,
      journalOpts: { ...ENABLED, enabled: false },
      pluginLogPath: pluginPath,
      now: () => NOW,
    });
    const data = (sendJson.mock.calls[0]?.[2] as { data: { plugin: Record<string, unknown>; note?: string } }).data;
    expect(data.note).toBe("journal_disabled");
    expect(data.plugin).toMatchObject({
      rows: 3,
      cardBound: 1,
      cardBoundFailed: 2,
      byReason: { http_status: 1, timeout: 1, empty: 0, parse: 0, other: 0 },
      excludedTestRows: 1,
      lastFailureAt: isoMinutesAgo(3),
      lastFailure: { reason: "http_status", identity: "t1/u1/a1" },
    });
  });

  it("v7：零字节绑定单独计数，无身份行不摊到租户（A4 复核）", async () => {
    const dir = tmpDir();
    const pluginPath = path.join(dir, "persona-injection.jsonl");
    const line = (row: Record<string, unknown>) => JSON.stringify(row);
    fs.writeFileSync(
      pluginPath,
      [
        line({ ts: isoMinutesAgo(6), event: "card-bound", identity: "t1/u1/a1", chars: 600 }),
        line({ ts: isoMinutesAgo(5), event: "card-bound", identity: "t1/u1/a1", chars: 0 }),
        line({ ts: isoMinutesAgo(4), event: "card-bound-failed", identity: "t1/u1/a1", reason: "empty" }),
        line({ ts: isoMinutesAgo(3), event: "card-bound", chars: 600 }),
      ].join("\n") + "\n",
      "utf8",
    );
    const sendJson = vi.fn();
    await handleSoulInjectionStatsRoute(new URL(`${SOUL_INJECTION_STATS_PATH}?team=t1&user=u1&agent=a1`, "http://localhost"), "GET", sendJson, res, {
      journalDir: dir,
      journalOpts: { ...ENABLED, enabled: false },
      pluginLogPath: pluginPath,
      now: () => NOW,
    });
    const data = (sendJson.mock.calls[0]?.[2] as { data: { plugin: Record<string, unknown> } }).data;
    expect(data.plugin).toMatchObject({
      rows: 3,
      cardBound: 1,
      cardBoundEmpty: 1,
      cardBoundFailed: 1,
      noIdentityRows: 1,
      excludedTestRows: 0,
    });
  });
  it("Round20：card-empty 进零字节桶；非计账事件（turn-append）单列 otherRows 且不撑破 rowsIdentity", async () => {
    const dir = tmpDir();
    const pluginPath = path.join(dir, "persona-injection.jsonl");
    const line = (row: Record<string, unknown>) => JSON.stringify(row);
    fs.writeFileSync(
      pluginPath,
      [
        line({ ts: isoMinutesAgo(6), event: "card-bound", identity: "t1/u1/a1", chars: 600 }),
        line({ ts: isoMinutesAgo(5), event: "card-empty", identity: "t1/u1/a1" }),
        line({ ts: isoMinutesAgo(4), event: "turn-append", identity: "t1/u1/a1", chars: 40 }),
        line({ ts: isoMinutesAgo(3), event: "section-read", identity: "t1/u1/a1", chars: 568 }),
      ].join("\n") + "\n",
      "utf8",
    );
    const sendJson = vi.fn();
    await handleSoulInjectionStatsRoute(new URL(`${SOUL_INJECTION_STATS_PATH}?team=t1&user=u1&agent=a1`, "http://localhost"), "GET", sendJson, res, {
      journalDir: dir,
      journalOpts: { ...ENABLED, enabled: false },
      pluginLogPath: pluginPath,
      now: () => NOW,
    });
    const data = (sendJson.mock.calls[0]?.[2] as { data: { plugin: Record<string, number> } }).data;
    const p = data.plugin;
    expect(p).toMatchObject({ rows: 3, sectionRead: 1, cardBound: 1, cardBoundEmpty: 0, cardEmpty: 1, otherRows: 1, cardBoundFailed: 0 });
    // 契约等式：rows 只由四个计账桶构成；turn-append 不再撑破它。
    expect(p.rows).toBe(p.sectionRead + p.cardBound + p.cardBoundEmpty + p.cardEmpty + p.cardBoundFailed);
  });

  it("v9：section-read 只算本租户；无身份行进 unattributed，不冒充任何租户（A5 Round10 P0）", async () => {
    const dir = tmpDir();
    const pluginPath = path.join(dir, "persona-injection.jsonl");
    const line = (row: Record<string, unknown>) => JSON.stringify(row);
    fs.writeFileSync(
      pluginPath,
      [
        line({ ts: isoMinutesAgo(9), event: "card-bound", identity: "t1/u1/a1", chars: 600 }),
        line({ ts: isoMinutesAgo(8), event: "section-read", identity: "t1/u1/a1", chars: 568 }),
        line({ ts: isoMinutesAgo(7), event: "card-bound", identity: "t2/u2/a2", chars: 600 }),
        line({ ts: isoMinutesAgo(6), event: "section-read", identity: "t2/u2/a2", reason: "no-card" }),
        line({ ts: isoMinutesAgo(5), event: "section-read", identity: "t2/u2/a2", sidSource: "none" }),
        line({ ts: isoMinutesAgo(4), event: "section-read", reason: "no-card" }),
      ].join("\n") + "\n",
      "utf8",
    );
    const call = async (q: string) => {
      const sendJson = vi.fn();
      await handleSoulInjectionStatsRoute(new URL(`${SOUL_INJECTION_STATS_PATH}?${q}`, "http://localhost"), "GET", sendJson, res, {
        journalDir: dir,
        journalOpts: { ...ENABLED, enabled: false },
        pluginLogPath: pluginPath,
        now: () => NOW,
      });
      return (sendJson.mock.calls[0]?.[2] as { data: { plugin: Record<string, unknown> } }).data;
    };
    const own = (await call("team=t1&user=u1&agent=a1")).plugin;
    expect(own).toMatchObject({ rows: 2, cardBound: 1, sectionRead: 1, sectionReadNoCard: 0, sectionReadNoSession: 0, noIdentityRows: 1 });
    expect(own.unattributed).toMatchObject({ sectionRead: 1, noCard: 1, emptySegment: 0, noSession: 0 });
    // 不存在的租户不能读到别人的 section-read（旧实现会把全集群数字算给任意租户）
    const ghost = (await call("team=zzz&user=zz&agent=zz")).plugin;
    expect(ghost).toMatchObject({ rows: 0, sectionRead: 0, sectionReadNoCard: 0, sectionReadNoSession: 0 });
    expect(ghost.unattributed).toMatchObject({ sectionRead: 1, noCard: 1 });
  });

  it("v8：section-read 的没注入原因按事件计数，无身份行也可见（A5 Round9 CP4）", async () => {
    const dir = tmpDir();
    const pluginPath = path.join(dir, "persona-injection.jsonl");
    const line = (row: Record<string, unknown>) => JSON.stringify(row);
    fs.writeFileSync(
      pluginPath,
      [
        line({ ts: isoMinutesAgo(6), event: "section-read", identity: "t1/u1/a1", reason: "no-card" }),
        line({ ts: isoMinutesAgo(5), event: "section-read", identity: "t1/u1/a1", reason: "empty-segment" }),
        line({ ts: isoMinutesAgo(4), event: "section-read", identity: "t1/u1/a1", sidSource: "none" }),
        line({ ts: isoMinutesAgo(3), event: "section-read", identity: "t1/u1/a1", chars: 568 }),
        line({ ts: isoMinutesAgo(2), event: "section-read", reason: "no-card" }),
      ].join("\n") + "\n",
      "utf8",
    );
    const sendJson = vi.fn();
    await handleSoulInjectionStatsRoute(new URL(`${SOUL_INJECTION_STATS_PATH}?team=t1&user=u1&agent=a1`, "http://localhost"), "GET", sendJson, res, {
      journalDir: dir,
      journalOpts: { ...ENABLED, enabled: false },
      pluginLogPath: pluginPath,
      now: () => NOW,
    });
    const data = (sendJson.mock.calls[0]?.[2] as { data: { plugin: Record<string, unknown> } }).data;
    expect(data.plugin).toMatchObject({
      sectionRead: 4,
      sectionReadNoCard: 1,
      sectionReadEmptySegment: 1,
      sectionReadNoSession: 1,
      noIdentityRows: 1,
      unattributed: { sectionRead: 1, noCard: 1, emptySegment: 0, noSession: 0 },
    });
  });
  it("A1 Round25：无身份的 card-bound-failed 也按 reason 聚合（租户口径仍为 0，不摊派）", async () => {
    const dir = tmpDir();
    const pluginPath = path.join(dir, "persona-injection.jsonl");
    const line = (row: Record<string, unknown>) => JSON.stringify(row);
    fs.writeFileSync(
      pluginPath,
      [
        // 真实会话：插件拿不到 identity，失败行过去直接沉进 noIdentityRows，byReason 恒 0。
        line({ ts: isoMinutesAgo(9), event: "card-bound", chars: 0 }),
        line({ ts: isoMinutesAgo(8), event: "card-bound-failed", reason: "http_status", failStatus: 429 }),
        line({ ts: isoMinutesAgo(6), event: "card-bound-failed", reason: "timeout" }),
        line({ ts: isoMinutesAgo(4), event: "card-bound-failed", identity: "t1/u1/a1", reason: "parse" }),
      ].join("\n") + "\n",
      "utf8",
    );
    const sendJson = vi.fn();
    await handleSoulInjectionStatsRoute(new URL(`${SOUL_INJECTION_STATS_PATH}?team=t1&user=u1&agent=a1`, "http://localhost"), "GET", sendJson, res, {
      journalDir: dir,
      journalOpts: { ...ENABLED, enabled: false },
      pluginLogPath: pluginPath,
      now: () => NOW,
    });
    const plugin = (sendJson.mock.calls[0]?.[2] as { data: { plugin: Record<string, any> } }).data.plugin;
    // 租户口径只数带身份的那一条
    expect(plugin).toMatchObject({ cardBoundFailed: 1, byReason: { http_status: 0, timeout: 0, empty: 0, parse: 1, other: 0 } });
    // 集群口径把两条无身份失败按 reason 分开，且 lastFailure 带 HTTP 状态码
    expect(plugin.unattributed).toMatchObject({
      cardBoundFailed: 2,
      byReason: { http_status: 1, timeout: 1, empty: 0, parse: 0, other: 0 },
      cardBound: 0,
      cardBoundEmpty: 1,
    });
    expect(typeof plugin.unattributed.lastFailureAt).toBe("string");
  });

  it("Round26：card-cleared（用户主动不关联）单列 unassociated，不冒充零字节绑定", async () => {
    const dir = tmpDir();
    const pluginPath = path.join(dir, "persona-injection.jsonl");
    const line = (row: Record<string, unknown>) => JSON.stringify(row);
    fs.writeFileSync(
      pluginPath,
      [
        // 用户主动「本次不关联」的清卡行：三行都是同一个会话反复绑定的历史残渣（旧实现每 pre-step 一行）。
        line({ ts: isoMinutesAgo(9), event: "card-cleared", reason: "unassociated", chars: 0 }),
        line({ ts: isoMinutesAgo(8), event: "card-cleared", reason: "unassociated", chars: 0 }),
        line({ ts: isoMinutesAgo(7), event: " card-cleared ", reason: "unassociated", chars: 0 }),
        // 对照：真正的零字节绑定仍要算进 cardBoundEmpty。
        line({ ts: isoMinutesAgo(6), event: "card-bound", identity: "t1/u1/a1", chars: 0 }),
      ].join("\n") + "\n",
      "utf8",
    );
    const sendJson = vi.fn();
    await handleSoulInjectionStatsRoute(new URL(`${SOUL_INJECTION_STATS_PATH}?team=t1&user=u1&agent=a1`, "http://localhost"), "GET", sendJson, res, {
      journalDir: dir,
      journalOpts: { ...ENABLED, enabled: false },
      pluginLogPath: pluginPath,
      now: () => NOW,
    });
    const p = (sendJson.mock.calls[0]?.[2] as { data: { plugin: Record<string, any> } }).data.plugin;
    // 清卡是决定不是故障：单列，且不把主动退出算成注入失败。
    // r26e-a1：三行都没有 identity → 只进集群级桶，租户 unassociated 必须是 0
    // （旧实现把每一行的清卡都累加到任何调用方的 unassociated 上，面板于是显示
    // 本租户从未发生的「主动不关联」——生产上那 10 行全是 vitest 夹具）。
    expect(p.unassociated).toBe(0);
    expect(p.unconfigured).toBe(0);
    expect(p.unattributed.cleared).toBe(3);
    expect(p.rows).toBe(1);
    expect(p.cardBoundEmpty).toBe(1);
    expect(p.cardBound).toBe(0);
    expect(p.noIdentityRows).toBe(3);
  });

  it("Round26（r26e-a1）：带身份的清卡只算本租户，并按 reason 分开", async () => {
    const dir = tmpDir();
    const pluginPath = path.join(dir, "persona-injection.jsonl");
    const line = (row: Record<string, unknown>) => JSON.stringify(row);
    fs.writeFileSync(
      pluginPath,
      [
        line({ ts: isoMinutesAgo(6), event: "card-cleared", identity: "t1/u1/a1", reason: "unassociated" }),
        line({ ts: isoMinutesAgo(5), event: "card-cleared", identity: "t1/u1/a1", reason: "unconfigured" }),
        // 别的租户的清卡：本租户一个都不许看见。
        line({ ts: isoMinutesAgo(4), event: "card-cleared", identity: "t9/u9/a9", reason: "unassociated" }),
      ].join("\n") + "\n",
      "utf8",
    );
    const sendJson = vi.fn();
    await handleSoulInjectionStatsRoute(new URL(`${SOUL_INJECTION_STATS_PATH}?team=t1&user=u1&agent=a1`, "http://localhost"), "GET", sendJson, res, {
      journalDir: dir,
      journalOpts: { ...ENABLED, enabled: false },
      pluginLogPath: pluginPath,
      now: () => NOW,
    });
    const p = (sendJson.mock.calls[0]?.[2] as { data: { plugin: Record<string, any> } }).data.plugin;
    expect(p.unassociated).toBe(1);
    expect(p.unconfigured).toBe(1);
    // 清卡不是计账事件：进 otherRows，不进 rows。
    expect(p.rows).toBe(0);
    expect(p.otherRows).toBe(2);
    expect(p.unattributed.cleared).toBe(0);
  });

  it("A4 Round24 F7：事件名两侧空白不影响计账与分桶（进 rows 的必须同时进桶）", async () => {
    const dir = tmpDir();
    const pluginPath = path.join(dir, "persona-injection.jsonl");
    const line = (row: Record<string, unknown>) => JSON.stringify(row);
    fs.writeFileSync(
      pluginPath,
      [
        line({ ts: isoMinutesAgo(6), event: " card-empty ", identity: "t1/u1/a1" }),
        line({ ts: isoMinutesAgo(5), event: "card-bound ", identity: "t1/u1/a1", chars: 0 }),
        line({ ts: isoMinutesAgo(4), event: " section-read", identity: "t1/u1/a1", reason: "no-card" }),
        line({ ts: isoMinutesAgo(3), event: "card-bound-failed\t", identity: "t1/u1/a1", reason: "empty" }),
      ].join("\n") + "\n",
      "utf8",
    );
    const sendJson = vi.fn();
    await handleSoulInjectionStatsRoute(new URL(`${SOUL_INJECTION_STATS_PATH}?team=t1&user=u1&agent=a1`, "http://localhost"), "GET", sendJson, res, {
      journalDir: dir,
      journalOpts: { ...ENABLED, enabled: false },
      pluginLogPath: pluginPath,
      now: () => NOW,
    });
    const p = (sendJson.mock.calls[0]?.[2] as { data: { plugin: Record<string, unknown> } }).data.plugin;
    // 回归点：桶判定曾经用 raw ev.event，而 rows 用 trim 过的 eventName——带空白的事件名会「进 rows 不进桶」，
    // 把 rows = 四桶之和 这条恒等式打破（A4 Round24 CP1 指出该恒等式本身是代数真空）。
    expect(p.rows).toBe(4);
    expect(p.sectionRead).toBe(1);
    expect(p.cardBound).toBe(0);
    expect(p.cardBoundEmpty).toBe(1); // 只有 0 字符 card-bound；card-empty 单列进 cardEmpty（Round28）
    expect(p.cardEmpty).toBe(1);
    expect(p.cardBoundFailed).toBe(1);
  });

it("Round30：includeTest=1 才把测试身份行取回到 testRows，且永不摊进租户计数", async () => {
    const dir = tmpDir();
    const pluginPath = path.join(dir, "persona-injection.jsonl");
    const line = (row: Record<string, unknown>) => JSON.stringify(row);
    fs.writeFileSync(
      pluginPath,
      [
        line({ ts: isoMinutesAgo(6), event: "section-read", identity: "t1-test/u1/a1-test", reason: "no-card" }),
        line({ ts: isoMinutesAgo(5), event: "card-bound", identity: "t1-test/u1/a1-test", chars: 12 }),
        line({ ts: isoMinutesAgo(4), event: "card-bound-failed", identity: "t1-test/u1/a1-test", reason: "timeout" }),
        line({ ts: isoMinutesAgo(3), event: "turn-append", identity: "t1-test/u1/a1-test", chars: 7 }),
        line({ ts: isoMinutesAgo(2), event: "section-read", identity: "t1/u1/a1", reason: "no-card" }),
      ].join("\n") + "\n",
      "utf8",
    );
    const call = async (qs: string) => {
      const sendJson = vi.fn();
      await handleSoulInjectionStatsRoute(new URL(`${SOUL_INJECTION_STATS_PATH}?${qs}`, "http://localhost"), "GET", sendJson, res, {
        journalDir: dir,
        journalOpts: { ...ENABLED, enabled: false },
        pluginLogPath: pluginPath,
        now: () => NOW,
      });
      return (sendJson.mock.calls[0]?.[2] as { data: { plugin: Record<string, any> } }).data.plugin;
    };
    const base = await call("team=t1&user=u1&agent=a1");
    // 默认：测试行只被计数、不被取回，一个都不许混进本租户。
    expect(base.includeTest).toBe(false);
    expect(base.excludedTestRows).toBe(4);
    expect(base.rows).toBe(1);
    expect(base.sectionRead).toBe(1);
    expect(base.testRows.rows).toBe(0);
    expect(base.testRows.sectionRead).toBe(0);
    expect(base.unattributed.sectionRead).toBe(0);
    const incl = await call("team=t1&user=u1&agent=a1&includeTest=1");
    // 取回：落进独立桶，租户计数逐字不变。
    expect(incl.includeTest).toBe(true);
    expect(incl.rows).toBe(1);
    expect(incl.sectionRead).toBe(1);
    expect(incl.testRows.sectionRead).toBe(1);
    expect(incl.testRows.cardBound).toBe(1);
    expect(incl.testRows.cardBoundFailed).toBe(1);
    expect(incl.testRows.otherRows).toBe(1);
    expect(incl.testRows.rows).toBe(3);
    // 恒等式：每条测试行恰好落进一个桶。
    expect(incl.testRows.rows + incl.testRows.otherRows + incl.testRows.cleared).toBe(incl.excludedTestRows);
    // 查的租户自己就是测试身份时，includeTest=1 必须当正常行计账（否则「可取回」只对别人的行成立）。
    const ownDefault = await call("team=t1-test&user=u1&agent=a1-test");
    expect(ownDefault.rows).toBe(0);
    const ownIncl = await call("team=t1-test&user=u1&agent=a1-test&includeTest=1");
    expect(ownIncl.rows).toBe(3);
    expect(ownIncl.testRows.rows).toBe(0);
  });
  it("Round28：缺段身份不冒充租户、无身份桶守恒、proof 用段行整卡 hash 对账（r28c-a4）", async () => {
    const dir = tmpDir();
    const pluginPath = path.join(dir, "persona-injection.jsonl");
    const line = (row: Record<string, unknown>) => JSON.stringify(row);
    const cardHash = "e".repeat(64);
    const segmentHash = "f".repeat(64);
    fs.writeFileSync(
      pluginPath,
      [
        line({ ts: isoMinutesAgo(6), event: "card-bound", identity: "t1//a1", chars: 300 }),
        line({ ts: isoMinutesAgo(5), event: "card-bound", identity: "t1/u1/a1", chars: 300, sessionId: "s-hash", hash: cardHash }),
        line({ ts: isoMinutesAgo(4), event: "section-read", identity: "t1/u1/a1", sessionId: "s-hash", chars: 20, cardHash, hash: segmentHash }),
        line({ ts: isoMinutesAgo(3), event: "turn-append", identity: "t1/u1/a1", chars: 10 }),
        line({ ts: isoMinutesAgo(2), event: "turn-append", chars: 10 }),
      ].join("\n") + "\n",
      "utf8",
    );
    writeJournal(dir, "t1", "a1", [
      injection({ ts: isoMinutesAgo(5), sessionKey: "s-hash", card: { version: 9, hash: cardHash, chars: 300 } }),
    ]);
    const sendJson = vi.fn();
    await handleSoulInjectionStatsRoute(new URL(SOUL_INJECTION_STATS_PATH + "?team=t1&user=u1&agent=a1", "http://localhost"), "GET", sendJson, res, {
      journalDir: dir,
      journalOpts: ENABLED,
      pluginLogPath: pluginPath,
      now: () => NOW,
    });
    const data = (sendJson.mock.calls[0]?.[2] as { data: { plugin: Record<string, any>; proof: Record<string, number> } }).data;
    const p = data.plugin;
    // rows 只数四类计账事件：card-bound + section-read；带身份的 turn-append 进 otherRows。
    expect(p.rows).toBe(2);
    expect(p.sectionRead).toBe(1);
    expect(p.cardBound).toBe(1);
    expect(p.cardBoundEmpty).toBe(0);
    expect(p.otherRows).toBe(1);
    const un = p.unattributed as Record<string, number>;
    expect(un.cardBound).toBe(1);
    expect(un.other).toBe(1);
    expect(p.noIdentityRows).toBe(un.sectionRead + un.cardBound + un.cardBoundEmpty + un.cardBoundFailed + un.cleared + un.other);
    expect(data.proof).toMatchObject({ sectionCardHashCount: 1, textHashMatched: 1, sessionsWithProof: 1 });
  });
  it("卡 chars 与召回整卡 chars 定义不同：不得记成 charMismatch（A5 复核）", async () => {
    const dir = tmpDir();
    writeJournal(dir, "t1", "a1", [
      injection({ ts: isoMinutesAgo(5), sessionKey: "s1", card: { version: 7, hash: "d".repeat(64), chars: 584 } }),
    ]);
    writeJournal(dir, "t1", "a1", [
      recall({ ts: isoMinutesAgo(6), sessionKey: "s1", soul: { sessionInit: { version: 7, hash: "e".repeat(64), chars: 1291 } } }),
    ], ".1");
    const { sendJson } = await call(`${SOUL_INJECTION_STATS_PATH}?team=t1&agent=a1`, "GET", dir);
    const data = (sendJson.mock.calls[0]?.[2] as { data: Record<string, unknown> }).data;
    expect(data.pairs).toMatchObject({ charMismatch: 0 });
  });
  it("A4（Round5）：usage 行按会话聚合（rows/sessions/withOverlap/avg/max）", async () => {
    const dir = tmpDir();
    writeJournal(dir, "t1", "a1", [
      injection({ ts: isoMinutesAgo(5), sessionKey: "s1", usage: { matchedLines: 2, totalLines: 8, overlapPct: 25 } }),
      injection({ ts: isoMinutesAgo(4), sessionKey: "s1", usage: { matchedLines: 0, totalLines: 5, overlapPct: 0 } }),
      injection({ ts: isoMinutesAgo(3), sessionKey: "s2", usage: { matchedLines: 3, totalLines: 6, overlapPct: 50 } }),
    ]);
    const { sendJson } = await call(`${SOUL_INJECTION_STATS_PATH}?team=t1&agent=a1`, "GET", dir);
    const data = (sendJson.mock.calls[0]?.[2] as { data: { usage: Record<string, unknown> } }).data;
    expect(data.usage).toMatchObject({
      rows: 3,
      sessions: 2,
      withOverlap: 2,
      avgOverlapPct: 25,
      maxOverlapPct: 50,
    });
  });
  it("A4（Round5）：usage-only 行不算注入行，也不满足 pairs（M1 复核）", async () => {
    const dir = tmpDir();
    writeJournal(dir, "t1", "a1", [
      injection({ ts: isoMinutesAgo(4), sessionKey: "s1", usage: { matchedLines: 2, totalLines: 8, overlapPct: 25 } }),
    ]);
    writeJournal(dir, "t1", "a1", [
      recall({ ts: isoMinutesAgo(5), sessionKey: "s1", soul: { sessionInit: { version: 1, hash: "h1", chars: 10 } } }),
    ], ".1");
    const { sendJson } = await call(`${SOUL_INJECTION_STATS_PATH}?team=t1&agent=a1`, "GET", dir);
    const data = (sendJson.mock.calls[0]?.[2] as { data: Record<string, any> }).data;
    expect(data.rows).toBe(0);
    expect(data.pairs).toEqual({ matched: 0, charMismatch: 0 });
    expect(data.serverRenderOnly).toBe(1);
    expect(data.usage.rows).toBe(1);
  });
});
