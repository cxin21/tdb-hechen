/**
 * D-R3-2（任务6）：boot recovery 死键过滤的数据前提——hasL0Session 存在性查询（RED 先行）。
 *
 * 登记根因：boot recovery 的 recoveryKeys = runner_states ∪ L0 全会话键，其中 runner_states
 * 残留键可能已无 L0 数据（测试会话清理/游标终结）——每次重启白挂 L1_drain 定时器
 * （活体证据 2026-09-24：单次 boot re-arm 156 会话，其中 28 键无 L0 数据）。
 * 修复=server.ts boot recovery 处按 hasL0Session 过滤；本用例钉死 store 层契约。
 * 语义与 listL0SessionIds 同族：session_id 为跨租户全局键（uuid 全局唯一），无租户参数。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../sqlite.js";
import type { L0Record } from "../types.js";

function makeStore(name: string): { store: VectorStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `l0-session-${name}-`));
  const store = new VectorStore(path.join(dir, "vectors.db"), 0);
  const initRes = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级：${JSON.stringify(initRes)}`);
  return { store, dir };
}

const T_A = { teamId: "t1", userId: "u1", agentId: "a1" };

function mkL0(id: string, sessionId: string, tenant: { teamId?: string; userId?: string; agentId?: string }): L0Record {
  return {
    id,
    sessionKey: sessionId,
    sessionId,
    taskId: "task-dr32",
    role: "user",
    messageText: `消息 ${id}`,
    recordedAt: new Date().toISOString(),
    timestamp: Date.now(),
    ...tenant,
  };
}

describe("D-R3-2 hasL0Session（boot recovery 死键过滤数据前提）", () => {
  it("① 有 L0 数据的会话键 → true；无数据键 → false（死键判定）", () => {
    const { store, dir } = makeStore("basic");
    try {
      store.upsertL0(mkL0("m1", "session-live-1", T_A), undefined);
      expect(store.hasL0Session!("session-live-1")).toBe(true);
      expect(store.hasL0Session!("session-flowtest-20260916-c")).toBe(false);
    } finally { try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ } }
  });

  it("② 与 listL0SessionIds 同族：枚举出的键 hasL0Session 全真（语义一致性）", () => {
    const { store, dir } = makeStore("consistency");
    try {
      store.upsertL0(mkL0("m1", "session-a", T_A), undefined);
      store.upsertL0(mkL0("m2", "session-b", T_A), undefined);
      store.upsertL0(mkL0("m3", "session-b", T_A), undefined);
      const ids = store.listL0SessionIds!();
      expect(ids.sort()).toEqual(["session-a", "session-b"]);
      expect(ids.every((id) => store.hasL0Session!(id))).toBe(true);
    } finally { try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ } }
  });

  it("③ 空串与退化输入 → false（宁缺毋滥不误挂定时器）", () => {
    const { store, dir } = makeStore("degenerate");
    try {
      expect(store.hasL0Session!("")).toBe(false);
      expect(store.hasL0Session!("nonexistent")).toBe(false);
    } finally { try { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ } }
  });
});
