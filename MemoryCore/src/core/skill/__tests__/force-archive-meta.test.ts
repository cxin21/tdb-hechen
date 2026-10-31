/**
 * force-archive 不得清掉 meta 的既有字段（task-33）。
 *
 * 背景：gateway/skill-handlers.ts 的 force-archive 曾自己拼一个完整 SessionMeta
 * 写入，漏了 task-26 的 recent_fingerprints ⇒ 走一次手动强制归档就把指纹环清空，
 * 之后落在归档窗口内的 outbox 重试又能重复入 buffer。现在改成 buffer.updateMeta
 * 读改写，本测试直接走真实 handleForceArchive + 真实 SkillBufferStorage 验证。
 */
import { describe, it, expect, vi } from "vitest";
import { SkillBufferStorage } from "../conversation-add/buffer-storage.js";
import { SkillConversationAddHandler } from "../conversation-add/add-handler.js";
import { handleForceArchive } from "../../../gateway/skill-handlers.js";

const SESS = {
  instance_id: "default",
  session_id: "s1",
  space_id: "default",
  user_id: "u1",
  team_id: "t1",
  agent_id: "agt-1",
};

function makeStorage() {
  const files = new Map<string, string>();
  return {
    readFile: vi.fn(async (key: string) => files.get(key) ?? null),
    writeFile: vi.fn(async (key: string, content: string | Buffer) => {
      files.set(key, typeof content === "string" ? content : content.toString("utf8"));
    }),
    exists: vi.fn(async (key: string) => files.has(key)),
    files,
  };
}

function makeWired() {
  const storage = makeStorage();
  const buffer = new SkillBufferStorage({ storage: storage as never, subPath: "skill_buffer" });
  const archive = vi.fn(async () => ({ taskId: "task-1", archiveKey: "arch-1", archivedAtMs: 2_000_000 }));
  const trigger = { archive };
  const handler = new SkillConversationAddHandler({
    buffer,
    trigger: trigger as never,
    now: () => 1_000_000,
  });
  const wired = { handler, trigger, buffer, sink: {}, queue: {} };
  return { wired, buffer, archive, storage };
}

const AUTH = { apiKey: "test-key", serviceId: "default" };

function makeDeps(wired: unknown) {
  return {
    resolveConversationAdd: async () => wired,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as never;
}

const body = {
  space_id: SESS.space_id,
  user_id: SESS.user_id,
  team_id: SESS.team_id,
  agent_id: SESS.agent_id,
  session_id: SESS.session_id,
  reason: "manual",
};

describe("force-archive 保留 meta 既有字段（task-33）", () => {
  it("归档后 recent_fingerprints 仍在且长度不变，计数与 buffer 仍按原语义重置", async () => {
    const { wired, buffer } = makeWired();
    await wired.handler.handle({
      ...SESS,
      messages: [
        { role: "user", content: "A1" },
        { role: "assistant", content: "A2" },
        { role: "tool_call", content: "sha-c1", tool_call_id: "c1" },
        { role: "tool_result", content: "result-c1", tool_call_id: "c1" },
      ] as never,
    });
    const before = await buffer.readMeta(SESS);
    expect(before.recent_fingerprints).toHaveLength(4);
    expect(before.tool_call_count).toBe(1);
    expect(before.byte_count).toBeGreaterThan(0);
    expect((await buffer.readCurrent(SESS)).messages).toHaveLength(4);

    const res = await handleForceArchive(body, AUTH, "req-1", makeDeps(wired));
    expect(res.code).toBe(0);
    expect((res.data as { status: string }).status).toBe("archived");

    const after = await buffer.readMeta(SESS);
    // 核心断言：环一字不动
    expect(after.recent_fingerprints).toEqual(before.recent_fingerprints);
    // 归档语义没被改坏：计数归零、last_archived_at_ms 更新
    expect(after.tool_call_count).toBe(0);
    expect(after.byte_count).toBe(0);
    expect(after.last_archived_at_ms).toBe(2_000_000);
    expect((await buffer.readCurrent(SESS)).messages).toHaveLength(0);
  });

  it("force-archive 之后重放归档前的 payload：被判重，buffer 不翻倍", async () => {
    const { wired, buffer } = makeWired();
    const payload = [{ role: "user", content: "A1" }, { role: "assistant", content: "A2" }] as never;
    await wired.handler.handle({ ...SESS, messages: payload });
    await handleForceArchive(body, AUTH, "req-2", makeDeps(wired));

    const replay = await wired.handler.handle({ ...SESS, messages: payload });
    expect(replay.status).toBe("ok");
    expect(replay.duplicate_skipped).toBe(2);
    expect((await buffer.readCurrent(SESS)).messages).toHaveLength(0);
    const meta = await buffer.readMeta(SESS);
    expect(meta.byte_count).toBe(0);
    expect(meta.recent_fingerprints).toHaveLength(2);
  });

  it("身份字段与未知字段不被 updateMeta 抹掉", async () => {
    const { wired, buffer } = makeWired();
    // 模拟未来版本写入的未知字段（旧代码手拼对象会直接丢掉）
    const seeded = {
      ...(await buffer.readMeta(SESS)),
      recent_fingerprints: [{ h: "deadbeef", t: 999_000 }],
      future_flag: "keep-me",
    };
    await buffer.writeMeta(SESS, seeded as never);

    await handleForceArchive(body, AUTH, "req-3", makeDeps(wired));

    const after = (await buffer.readMeta(SESS)) as unknown as Record<string, unknown>;
    expect(after.future_flag).toBe("keep-me");
    expect(after.recent_fingerprints).toEqual([{ h: "deadbeef", t: 999_000 }]);
    expect(after.session_id).toBe(SESS.session_id);
    expect(after.tool_call_count).toBe(0);
  });
});
