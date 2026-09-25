/**
 * F-DUP-1（任务5）：入口幂等数据前提——hasRecentL0Duplicate 窗口查重（RED 先行）。
 *
 * 根因（td-agemem-fdup1-l0-dedup 技能实锚）：DSH 插件按每轮 LLM 调用重复提交同条用户消息
 * （一次「继续」存 12 条、20-30s 间隔、跨约 5 分钟）。修复=入口幂等：同 session+role+content
 * 在 10min 窗口内的重复提交跳过（窗口覆盖单回合连发上限、远小于真实重发间隔）。
 */
import { describe, expect, it } from "vitest";
import { VectorStore } from "../sqlite.js";
import type { L0Record } from "../types.js";

function makeStore(name: string): { store: VectorStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `l0-dup-${name}-`));
  const store = new VectorStore(path.join(dir, "vectors.db"), 0);
  const initRes = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级：${JSON.stringify(initRes)}`);
  return { store, dir };
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const T_A = { teamId: "t1", userId: "u1", agentId: "a1" };

function mkL0(id: string, sessionId: string, role: string, content: string, recordedAtMs: number): L0Record {
  return {
    id,
    sessionKey: sessionId,
    sessionId,
    taskId: "task-fdup1",
    role,
    messageText: content,
    recordedAt: new Date(recordedAtMs).toISOString(),
    timestamp: recordedAtMs,
    ...T_A,
  };
}

const WINDOW = 600000; // 10min

describe("F-DUP-1 hasRecentL0Duplicate（入口幂等查重）", () => {
  it("① 窗口内同 session+role+content → true（DSH 连发重复场景）", () => {
    const { store, dir } = makeStore("hit");
    try {
      const now = Date.now();
      store.upsertL0(mkL0("m1", "session-x", "user", "继续", now - 30_000), undefined); // 30s 前
      expect(store.hasRecentL0Duplicate!("session-x", "user", "继续", WINDOW)).toBe(true);
    } finally { try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ } }
  });

  it("② 窗口外（>10min）→ false（用户隔小时级真实重发照存）", () => {
    const { store, dir } = makeStore("outside");
    try {
      const now = Date.now();
      store.upsertL0(mkL0("m1", "session-x", "user", "继续", now - 11 * 60_000), undefined); // 11min 前
      expect(store.hasRecentL0Duplicate!("session-x", "user", "继续", WINDOW)).toBe(false);
    } finally { try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ } }
  });

  it("③ 键维度任一不同 → false（role/session/content 逐字比对）", () => {
    const { store, dir } = makeStore("dims");
    try {
      const now = Date.now();
      store.upsertL0(mkL0("m1", "session-x", "user", "继续", now - 30_000), undefined);
      expect(store.hasRecentL0Duplicate!("session-x", "assistant", "继续", WINDOW)).toBe(false); // role 不同
      expect(store.hasRecentL0Duplicate!("session-y", "user", "继续", WINDOW)).toBe(false); // session 不同
      expect(store.hasRecentL0Duplicate!("session-x", "user", "继续一下", WINDOW)).toBe(false); // content 不同
    } finally { try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ } }
  });

  it("④ 退化输入 → false（宁缺毋滥不误跳）", () => {
    const { store, dir } = makeStore("degenerate");
    try {
      expect(store.hasRecentL0Duplicate!("", "user", "继续", WINDOW)).toBe(false);
      expect(store.hasRecentL0Duplicate!("session-x", "", "继续", WINDOW)).toBe(false);
      expect(store.hasRecentL0Duplicate!("session-x", "user", "", WINDOW)).toBe(false);
      expect(store.hasRecentL0Duplicate!("session-x", "user", "继续", 0)).toBe(false);
    } finally { try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ } }
  });
});
