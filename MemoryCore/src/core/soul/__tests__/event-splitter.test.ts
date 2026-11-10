/**
 * P1-A：聊天事件切分 + 行动事件落库。
 *
 * 为什么单独测这一层：P0 的事件底座已经能写「一条 episode = 一条事件」，
 * 但那让「一条消息里的测试失败、回滚、再提交」挤成一条，查询时只能看到一句标题。
 * 这里钉住三件事：
 *   1. 只从 assistant 的逐字引文里切，不拿用户请求假装成已发生的行动；
 *   2. 一条消息最多 1 个根事件 + 2 个行动子事件，子事件带 parent_event_id 和逐字证据；
 *   3. 行动事件写面只收 args 摘要，原始参数绝不进事件表。
 */
import { describe, expect, it } from "vitest";
import {
  buildSoulActionWrite,
  digestSoulActionArgs,
  soulActionEventId,
  splitChatActionEvents,
} from "../event-splitter.js";
import type { SoulEpisode } from "../types.js";

function episode(overrides: Partial<SoulEpisode> = {}): SoulEpisode {
  return {
    episodeId: "ep-1",
    at: "2026-11-10T02:00:00.000Z",
    day: "2026-11-10",
    kind: "work",
    title: "跑测试",
    object: "测试",
    participants: ["何晨", "assistant"],
    userStance: "跑下测试",
    agentStance: "",
    cost: "",
    outcome: "",
    valence: 0,
    arousal: 0,
    intensity: 0,
    evidenceIds: ["l0-1"],
    sessionId: "s1",
    quote: { text: "测试挂了，我先回滚了", role: "assistant", recordId: "l0-1" },
    affectSource: "none",
    persons: ["p_name_he"],
    ...overrides,
  };
}

describe("P1-A splitChatActionEvents", () => {
  it("只切 assistant 的逐字引文：用户请求、无引文、空文本都不产行动子事件", () => {
    expect(splitChatActionEvents(episode({ quote: { text: "测试挂了", role: "user", recordId: "l0-1" } }))).toEqual([]);
    expect(splitChatActionEvents(episode({ quote: null }))).toEqual([]);
    expect(splitChatActionEvents(episode({ quote: { text: "   ", role: "assistant", recordId: "l0-1" } }))).toEqual([]);
  });

  it("根事件引文是 user 时，从 evidenceIds 回查到的 assistant 原话切行动，证据不回指用户", () => {
    const writes = splitChatActionEvents(episode(), [
      { recordId: "msg-assistant-1", role: "assistant", text: "跑完全量测试，全绿；提交了 901d1e9" },
    ]);
    expect(writes.map((w) => w.event.source_kind)).toEqual(["test", "commit"]);
    expect(writes.map((w) => w.event.parent_event_id)).toEqual(["ep-1", "ep-1"]);
    expect(writes.map((w) => w.evidence?.[0]?.record_id)).toEqual(["msg-assistant-1", "msg-assistant-1"]);
    expect(writes.every((w) => w.evidence?.[0]?.role === "assistant")).toBe(true);
    expect(writes[1].event.object).toBe("提交 901d1e9");
  });

  it("一条消息切出测试失败 + 回滚两件事，父事件与逐字证据都在", () => {
    const writes = splitChatActionEvents(episode());
    expect(writes.map((w) => w.event.event_id)).toEqual(["ep-1:test", "ep-1:rollback"]);
    expect(writes.map((w) => w.event.source_kind)).toEqual(["test", "rollback"]);
    expect(writes.map((w) => w.event.parent_event_id)).toEqual(["ep-1", "ep-1"]);
    expect(writes.map((w) => w.event.action)).toEqual(["tested", "rolled_back"]);
    expect(writes[0].event.status).toBe("failed");
    expect(writes[0].evidence).toMatchObject([{ record_id: "l0-1", role: "assistant", quote: "测试挂了" }]);
    expect(writes[1].evidence).toMatchObject([{ record_id: "l0-1", role: "assistant", quote: "我先回滚了" }]);
    expect(writes[0].action).toMatchObject({ tool: "test", result_status: "fail", verified_by: null });
    expect(writes[1].action).toMatchObject({ tool: "git", result_status: "unknown", verified_by: null });
    // 自述不是验证：有引文也只能是 inferred，confidence 不超过 0.5。
    expect(writes[0].event.epistemic).toBe("inferred");
    expect(writes[0].event.confidence).toBe(0.5);
    expect(writes[0].event.dedupe_key).toBe("soul-episode:ep-1:test");
  });

  it("把跨逗号的短结果并回前一个动作，不把「全绿」单独丢掉", () => {
    const writes = splitChatActionEvents(
      episode({ quote: { text: "跑完全量测试，全绿；提交了 901d1e9", role: "assistant", recordId: "l0-1" } }),
    );
    expect(writes.map((w) => w.event.source_kind)).toEqual(["test", "commit"]);
    expect(writes[0].event.status).toBe("done");
    expect(writes[0].action?.result_status).toBe("success");
    expect(writes[1].event.status).toBe("done");
    expect(writes[1].event.object).toBe("提交 901d1e9");
    expect(writes[1].action?.artifact_ref).toBe("901d1e9");
  });

  it("请求句、否定句、没有动作词的句子都不切", () => {
    expect(
      splitChatActionEvents(episode({ quote: { text: "帮我跑下测试", role: "assistant", recordId: "l0-1" } })),
    ).toEqual([]);
    expect(
      splitChatActionEvents(episode({ quote: { text: "没跑测试", role: "assistant", recordId: "l0-1" } })),
    ).toEqual([]);
    expect(
      splitChatActionEvents(episode({ quote: { text: "今天天气不错", role: "assistant", recordId: "l0-1" } })),
    ).toEqual([]);
  });

  it("规则、否定、清单、名词「测试」都不被当成已发生的行动", () => {
    const quotes = [
      "**我不会做的**：不扩标签集、不重写情绪模型、不把回滚改成每轮自动",
      "测试红了只报告，不修",
      "8) 已退场面是否复活：grep 以下词在 src 非测试文件里的活引用",
      "测试人设现在是**小满**，不是空壳了",
      "红就退回去让它改，不会拿「正在改」当通过",
      "验收：跑满 50 条样本后能给出四维通过率，且与人工抽检一致率 ≥0.8",
      "它交付后我会自己跑 npm test 和 build，再同步 dist",
      "在那之前先说清楚现在核实过的状态：砚舟这个测试 agent 已经从生产删干净了",
      "另外记一个污染项：该日志里的几条是测试跑出来的",
      "每段写四行：改了什么（path:line）｜跑了什么门（贴原始输出行）｜怎么证明生效｜怎么回滚",
      "WAL 也合并到 0 了",
      '"title":"人格层 v3.7 终验：修完 + 自跑门禁"}',
      '"content":"门：tsc exit 0、插件 40 files / 734 tests、build exit 0"',
    ];
    for (const quote of quotes) {
      expect(splitChatActionEvents(episode({ quote: { text: quote, role: "assistant", recordId: "l0-1" } }))).toEqual(
        [],
      );
    }
  });

  it("业务语料里的「提交订单/必须提交」不是 git commit", () => {
    const quote = "前端契约确实变了：按钮必须提交委外订单表头主键 `pk_order`";
    expect(splitChatActionEvents(episode({ quote: { text: quote, role: "assistant", recordId: "l0-1" } }))).toEqual([]);
  });

  it("有动作也有结果的真句仍保留：测试门与对拍通过", () => {
    const gate = splitChatActionEvents(
      episode({
        quote: {
          text: "门：tsc --noEmit 干净、vitest 40 files / 724 tests、build 干净",
          role: "assistant",
          recordId: "l0-1",
        },
      }),
    );
    expect(gate.map((w) => w.event.source_kind)).toEqual(["test"]);
    expect(gate[0].event.status).toBe("done");
    const pair = splitChatActionEvents(
      episode({ quote: { text: "对拍测试改「完全一致」并 22 tests 通过", role: "assistant", recordId: "l0-1" } }),
    );
    expect(pair.map((w) => w.event.source_kind)).toEqual(["test"]);
    expect(pair[0].action?.result_status).toBe("success");
  });

  it("最多两个子事件，且重跑得到同一组 event_id", () => {
    const text = "测试挂了，回滚了，提交了 901d1e9";
    const first = splitChatActionEvents(episode({ quote: { text, role: "assistant", recordId: "l0-1" } }));
    const second = splitChatActionEvents(episode({ quote: { text, role: "assistant", recordId: "l0-1" } }));
    expect(first).toHaveLength(2);
    expect(first.map((w) => w.event.event_id)).toEqual(second.map((w) => w.event.event_id));
  });
});

describe("P1-A 行动事件写面", () => {
  it("args 只落 sha256 摘要，稳定排序且原文不出现", () => {
    const a = digestSoulActionArgs({ token: "secret", z: 1, a: 2 });
    const b = digestSoulActionArgs({ a: 2, z: 1, token: "secret" });
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a).not.toContain("secret");
  });

  it("有工具逐字证据时写 observed，action 子表字段齐全且不存原始参数", () => {
    const write = buildSoulActionWrite({
      eventId: "act-test-1",
      at: "2026-11-10T03:00:00.000Z",
      sessionId: "s1",
      sourceKind: "test",
      action: "tested",
      object: "单元测试",
      intent: "复跑 P1-A",
      outcome: "通过",
      status: "success",
      sourceRef: "tool-1",
      tool: "vitest",
      toolCallId: "tool-1",
      args: { token: "secret", pattern: "event-splitter" },
      durationMs: 1234,
      artifactRef: "logs/vitest.log",
      environment: "local",
      verifiedBy: "self",
      evidence: [{ recordId: "tool-1", role: "tool", quote: "Test Files 1 passed", at: "2026-11-10T03:00:00.000Z" }],
    });
    expect(write.event).toMatchObject({
      event_id: "act-test-1",
      actor: "self",
      action: "tested",
      source_kind: "test",
      source_ref: "tool-1",
      status: "done",
      epistemic: "observed",
      confidence: 0.8,
      dedupe_key: "soul-action:act-test-1",
    });
    expect(write.action).toMatchObject({
      event_id: "act-test-1",
      tool: "vitest",
      tool_call_id: "tool-1",
      result_status: "success",
      duration_ms: 1234,
      artifact_ref: "logs/vitest.log",
      environment: "local",
      verified_by: "self",
    });
    expect(write.action?.args_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(write)).not.toContain("secret");
    expect(write.evidence?.[0]).toMatchObject({ record_id: "tool-1", role: "tool", quote: "Test Files 1 passed" });
  });

  it("没有证据时只能 inferred + 0.5；原始 args_digest 形态不合法直接拒绝", () => {
    const write = buildSoulActionWrite({
      at: "2026-11-10T03:00:00.000Z",
      sourceKind: "commit",
      action: "committed",
      status: "unknown",
      tool: "git",
      sourceRef: "901d1e9",
    });
    expect(write.event.epistemic).toBe("inferred");
    expect(write.event.confidence).toBe(0.5);
    expect(write.evidence).toEqual([]);
    expect(() =>
      buildSoulActionWrite({
        at: "2026-11-10T03:00:00.000Z",
        sourceKind: "tool",
        action: "ran",
        tool: "bash",
        argsDigest: "token=secret",
      }),
    ).toThrow(/args_digest/);
  });

  it("event_id 由来源与动作确定性生成", () => {
    const a = soulActionEventId("test", "tool-1", "tested");
    const b = soulActionEventId("test", "tool-1", "tested");
    expect(a).toBe(b);
    expect(a).toMatch(/^act-[0-9a-f]{16}$/);
    expect(soulActionEventId("commit", "tool-1", "tested")).not.toBe(a);
  });
});
