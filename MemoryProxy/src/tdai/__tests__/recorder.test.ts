import { describe, it, expect, vi, beforeEach } from "vitest";
import { recordTdaiTurn, resetSubmittedFingerprintsForTests } from "../recorder.js";
import type { TurnContext } from "../../common/intent-classifier.js";
import type { TdaiClient } from "../client.js";
import type { TdaiIdentity } from "../types.js";

// M1 最小修（审查 4544dc9d 发现，2026-10-22 亲验坐实）：classified 全量写 +
// core F-DUP-1 仅 10min 窗 + 步间实测 10-16min → 整史重复落库 O(T^2) 并逐条重 embed。
// 契约=classified 档按 role+content 指纹做 per-session 增量提交；legacy 档逐位不变。
function makeIdentity(sessionId: string): TdaiIdentity {
  return { teamId: "team-t", userId: "usr-u", agentId: "agt-a", sessionId, taskId: null, userKey: "sk-test" } as unknown as TdaiIdentity;
}
function makeClient(): { client: TdaiClient; addConversation: ReturnType<typeof vi.fn> } {
  const addConversation = vi.fn(async () => {});
  return { client: { addConversation } as unknown as TdaiClient, addConversation };
}
function turnContextOf(entries: { classification: string; text: string; raw: string }[], intentText: string | null): TurnContext {
  return {
    turnIntent: intentText === null ? null : { index: 0, text: intentText },
    classified: entries.map((e, i) => ({ index: i, classification: e.classification as never, text: e.text, raw: e.raw })),
  };
}
const HIST = [
  { classification: "real", text: "Q1", raw: "Q1" },
  { classification: "scaffold", text: "", raw: "[Compressed conversation section] body" },
];

describe("recordTdaiTurn - classified 档增量提交（M1 最小修）", () => {
  beforeEach(() => resetSubmittedFingerprintsForTests());

  it("同一会话整史重提交：第二次零发送（user+assistant 全部已提交）", async () => {
    const { client, addConversation } = makeClient();
    const ident = makeIdentity("sess-dedup-1");
    const tc = turnContextOf(HIST, "Q1");
    await recordTdaiTurn(client, ident, null, "A1", { captureMode: "classified", turnContext: tc });
    expect(addConversation).toHaveBeenCalledTimes(1);
    expect(addConversation.mock.calls[0][1]).toHaveLength(3); // 2 user + assistant
    await recordTdaiTurn(client, ident, null, "A1", { captureMode: "classified", turnContext: tc });
    expect(addConversation).toHaveBeenCalledTimes(1); // 全 seen → 不再调用
  });

  it("增量提交：历史相同 + 一条新 real → 只发新条目", async () => {
    const { client, addConversation } = makeClient();
    const ident = makeIdentity("sess-dedup-2");
    await recordTdaiTurn(client, ident, null, "A1", { captureMode: "classified", turnContext: turnContextOf(HIST, "Q1") });
    const tc2 = turnContextOf([...HIST, { classification: "real", text: "Q2", raw: "Q2" }], "Q2");
    await recordTdaiTurn(client, ident, null, "A1", { captureMode: "classified", turnContext: tc2 });
    expect(addConversation).toHaveBeenCalledTimes(2);
    const second = addConversation.mock.calls[1][1] as { role: string; content: string; classification?: string }[];
    expect(second).toHaveLength(1);
    expect(second[0].content).toBe("Q2");
    expect(second[0].classification).toBe("real");
  });

  it("跨会话指纹隔离：新会话全量提交", async () => {
    const { client, addConversation } = makeClient();
    const tc = turnContextOf(HIST, "Q1");
    await recordTdaiTurn(client, makeIdentity("sess-dedup-3"), null, "A1", { captureMode: "classified", turnContext: tc });
    await recordTdaiTurn(client, makeIdentity("sess-dedup-4"), null, "A1", { captureMode: "classified", turnContext: tc });
    expect(addConversation).toHaveBeenCalledTimes(2);
    expect((addConversation.mock.calls[1][1] as unknown[]).length).toBe(3);
  });

  it("legacy 档位不受指纹去重影响（逐位不变）", async () => {
    const { client, addConversation } = makeClient();
    const ident = makeIdentity("sess-dedup-5");
    const um = { role: "user" as const, content: "Q1" };
    await recordTdaiTurn(client, ident, um, "A1", { captureMode: "legacy" });
    await recordTdaiTurn(client, ident, um, "A1", { captureMode: "legacy" });
    expect(addConversation).toHaveBeenCalledTimes(2);
  });
});
