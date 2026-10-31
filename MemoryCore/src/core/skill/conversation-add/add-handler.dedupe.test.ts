/**
 * add-handler 入口幂等（task-26）回归测试。
 *
 * 证据：docs/ops/skill-feed-dedupe-evidence.md —— 修前同一 payload 连投两次
 * buffer 2→4、byte_count 翻倍；3 个唯一 tool_call 投 4 次就把阈值 10 打满，
 * 归档 48 条（唯一 12 条）。这里只验 buffer/meta 层，不触碰抽取链路。
 */
import { describe, it, expect, vi } from "vitest";
import { SkillConversationAddHandler } from "./add-handler.js";
import type { SessionKey, SessionMeta } from "./buffer-storage.js";

const SESS: SessionKey = {
  instance_id: "default",
  session_id: "s1",
  space_id: "default",
  user_id: "u1",
  team_id: "t1",
  agent_id: "agt-1",
};

type Msg = Record<string, unknown>;

function makeHandler(opts: {
  thresholds?: { toolCallThreshold?: number; bytesThreshold?: number; requestCompressThresholdBytes?: number };
  messages?: Msg[];
  nowRef?: { t: number };
  dedupeWindowMs?: number;
} = {}) {
  const nowRef = opts.nowRef ?? { t: 1_000_000 };
  let current: Msg[] = opts.messages ?? [];
  let meta: SessionMeta = {
    session_id: SESS.session_id,
    space_id: SESS.space_id,
    user_id: SESS.user_id,
    team_id: SESS.team_id,
    agent_id: SESS.agent_id,
    tool_call_count: 0,
    byte_count: 0,
    recent_fingerprints: [],
  };
  const buffer = {
    readCurrent: vi.fn(async () => ({ messages: current })),
    writeCurrent: vi.fn(async (_s: unknown, doc: { messages: Msg[] }) => { current = doc.messages; }),
    readMeta: vi.fn(async () => ({ ...meta })),
    writeMeta: vi.fn(async (_s: unknown, next: SessionMeta) => { meta = next; }),
    // 与真实 SkillBufferStorage.updateMeta 同语义：读改写，只覆盖 patch 字段。
    updateMeta: vi.fn(async (_s: unknown, patch: Partial<SessionMeta>) => {
      meta = { ...meta, ...patch };
      return meta;
    }),
  };
  const trigger = { archive: vi.fn(async (_input: unknown) => ({ taskId: "task-1", archiveKey: "arch-1", archivedAtMs: nowRef.t })) };
  const handler = new SkillConversationAddHandler({
    buffer: buffer as never,
    trigger: trigger as never,
    thresholds: opts.thresholds,
    dedupeWindowMs: opts.dedupeWindowMs,
    now: () => nowRef.t,
  });
  return {
    handler,
    buffer,
    trigger,
    nowRef,
    current: () => current,
    meta: () => meta,
  };
}

function userMsg(text: string): Msg {
  return { role: "user", content: text };
}
function toolPair(id: string, content = "sha-" + id): Msg[] {
  return [
    { role: "tool_call", content, tool_call_id: id },
    { role: "tool_result", content: "result-" + id, tool_call_id: id },
  ];
}

const input = (messages: Msg[]) => ({ ...SESS, task_id: "task-1", messages: messages as never });

describe("skill add-handler 入口幂等（task-26）", () => {
  it("同一 payload 连投两次：第二次全判重，buffer 与 byte_count 不变", async () => {
    const h = makeHandler();
    const payload = [userMsg("A1"), userMsg("A2")];

    const first = await h.handler.handle(input(payload));
    expect(first.status).toBe("ok");
    expect(first.duplicate_skipped).toBeUndefined();
    expect(h.current()).toHaveLength(2);
    const bytesAfterFirst = h.meta().byte_count;
    expect(bytesAfterFirst).toBeGreaterThan(0);

    const second = await h.handler.handle(input(payload));
    expect(second.status).toBe("ok");
    expect(second.duplicate_skipped).toBe(2);
    // 关键：一个字节都不追加
    expect(h.current()).toHaveLength(2);
    expect(h.meta().byte_count).toBe(bytesAfterFirst);
  });

  it("3 个唯一 tool_call 投 4 次：计数停在 3，不会第 4 次触发归档", async () => {
    const h = makeHandler();
    const payload = [userMsg("go"), ...toolPair("c1"), ...toolPair("c2"), ...toolPair("c3")];

    for (let i = 0; i < 4; i += 1) {
      await h.handler.handle(input(payload));
    }

    expect(h.meta().tool_call_count).toBe(3);
    expect(h.current()).toHaveLength(7);
    expect(h.trigger.archive).not.toHaveBeenCalled();
  });

  it("归档后再重放同一 payload 仍被拦住（指纹环跨归档保留）", async () => {
    const h = makeHandler({ thresholds: { toolCallThreshold: 1 } });
    const payload = [userMsg("A1"), ...toolPair("c1"), userMsg("A2")];

    const first = await h.handler.handle(input(payload));
    expect(first.status).toBe("archived");
    expect(h.current()).toHaveLength(0);
    expect(h.meta().recent_fingerprints?.length).toBe(4);

    const replay = await h.handler.handle(input(payload));
    expect(replay.status).toBe("ok");
    expect(replay.duplicate_skipped).toBe(4);
    // buffer 没被重新灌入，计数也没回涨
    expect(h.current()).toHaveLength(0);
    expect(h.meta().tool_call_count).toBe(0);
    expect(h.trigger.archive).toHaveBeenCalledTimes(1);
  });

  it("tool_call/tool_result 按 tool_call_id 判重：同 id 不同 content 仍算重复，不同 id 同 content 可接受", async () => {
    const h = makeHandler();
    const a = [
      { role: "tool_call", content: "call-v1", tool_call_id: "id-1" },
      { role: "tool_result", content: "res-v1", tool_call_id: "id-1" },
    ];
    await h.handler.handle(input(a as Msg[]));

    // 同 id、content 变了 → 仍然是同一次工具调用，判重
    const sameIdDifferentContent = [
      { role: "tool_call", content: "call-v2", tool_call_id: "id-1" },
      { role: "tool_result", content: "res-v2", tool_call_id: "id-1" },
    ];
    const r1 = await h.handler.handle(input(sameIdDifferentContent as Msg[]));
    expect(r1.duplicate_skipped).toBe(2);

    // 不同 id、content 完全一样 → 是两次真实调用，接受
    const diffIdSameContent = [
      { role: "tool_call", content: "call-v1", tool_call_id: "id-2" },
      { role: "tool_result", content: "res-v1", tool_call_id: "id-2" },
    ];
    const r2 = await h.handler.handle(input(diffIdSameContent as Msg[]));
    expect(r2.duplicate_skipped).toBeUndefined();
    expect(h.meta().tool_call_count).toBe(2);
  });

  it("批内重复也去掉：同一请求里重复的只算一次", async () => {
    const h = makeHandler();
    const res = await h.handler.handle(input([userMsg("A1"), userMsg("A2"), userMsg("A1")]));
    expect(res.duplicate_skipped).toBe(1);
    expect(h.current()).toHaveLength(2);
  });

  it("窗口过期后同样的内容可以重新入 buffer（buffer 已随归档清空）", async () => {
    const nowRef = { t: 1_000_000 };
    const h = makeHandler({ nowRef, dedupeWindowMs: 10 * 60 * 1000, thresholds: { toolCallThreshold: 1 } });
    const payload = [userMsg("A1"), ...toolPair("c1")];
    const first = await h.handler.handle(input(payload));
    expect(first.status).toBe("archived");
    expect(h.current()).toHaveLength(0);

    // 窗口内重放：环还在 → 拦住
    const withinWindow = await h.handler.handle(input(payload));
    expect(withinWindow.duplicate_skipped).toBe(3);

    nowRef.t += 10 * 60 * 1000 + 1;
    const later = await h.handler.handle(input(payload));
    expect(later.status).toBe("archived");
    expect(later.duplicate_skipped).toBeUndefined();
  });
});
