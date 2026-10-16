/**
 * #41（ADR0003-P3 实施票 C，D8 证据门）· (b) 确定性证据通道单一源测试。
 *
 * 合同（#41 票面验收 + ADR0003 D8 + 2026-10-16 对抗审查处置）：
 * - 确认话语 = 锚定全句白名单正则，且**必须带承诺指称**（审查 I2：裸赞同/裸否定
 *   「同意/不对/有问题」在任务语境与承诺语义混淆，且 byRefKey 全量+终态不可逆，
 *   误放向量过大 → 白名单收窄为承诺语义锚定形态；宁缺毋滥，漏报由 (a)/(c) 兜底）；
 * - 证据项 → 迁移映射确定性：confirmation:kept→kept / confirmation:broken→broken /
 *   tool_failure→broken / tool_success→kept；
 * - 关联 = promise.refKey === 证据 refKey 严格相等（双方缺 refKey → 不迁移）；
 * - 陈旧证据守卫（审查 I3）：证据 at（user 消息 timestamp）早于 promise.createdAt → 跳过
 *   （防毒批重放：先有话语后建 promise 的旧话语不得迁移新 promise）；任一缺时间 → 不设防；
 * - 溯源粒度（审查 M2）：note 带命中正则序号 #pN；采集 stamp at；
 * - 采集 helper：仅 user 消息参与（assistant 文本绝不触发）。
 */
import { describe, expect, it } from "vitest";
import {
  PROMISE_CONFIRMATION_KEPT_PATTERNS,
  PROMISE_CONFIRMATION_BROKEN_PATTERNS,
  matchConfirmationUtterance,
  collectPromiseEvidenceFromExtraction,
  evaluatePromiseEvidence,
  applyPromiseEvidence,
} from "../soul-promise-evidence.js";

describe("#41 · 确认话语白名单（锚定全句+承诺指称，审查 I2 收窄）", () => {
  it("白名单 kept 命中：承诺指称 + 兑现动词（锚定全句）", () => {
    for (const t of [
      "说好的做到了",
      "答应的事办完了",
      "承诺兑现了",
      "答应你的搞定了",
      "承诺的事都完成了",
      "这些承诺都兑现了",
      "说定的完成了",
    ]) {
      const hit = matchConfirmationUtterance(t);
      expect(hit, `应命中 kept：${t}`).not.toBeNull();
      expect(hit!.verdict).toBe("kept");
    }
  });

  it("白名单 broken 命中：承诺指称 + 未兑现 / 承诺失信习语", () => {
    for (const t of [
      "承诺没兑现",
      "说好的没做到",
      "答应的没有办完",
      "承诺未兑现",
      "说话不算话",
      "言而无信",
      "食言了",
    ]) {
      const hit = matchConfirmationUtterance(t);
      expect(hit, `应命中 broken：${t}`).not.toBeNull();
      expect(hit!.verdict).toBe("broken");
    }
  });

  it("裸赞同/裸否定一律不触发（审查 I2 探针回归：误放向量收口）", () => {
    for (const t of [
      // 原 kept 域裸形态（任务语境≠承诺兑现）
      "同意",
      "同意执行",
      "可以达成",
      "收到",
      "确认收到",
      "已完成",
      "做完了",
      "没问题",
      "定了",
      "验收通过",
      "好的，收到",
      "ok，已完成",
      // 原 broken 域裸形态（可指纠错/讨论，非承诺未兑现）
      "不对",
      "不行",
      "有问题",
      "还有问题",
      "这个不对",
      "它有问题",
      "打回",
      "返工吧",
      "重做",
      "没做到",
    ]) {
      expect(matchConfirmationUtterance(t), `不应命中：${t}`).toBeNull();
    }
  });

  it("白名单之外一律不触发（前缀弱化/后缀续句/疑问/非字符串）", () => {
    for (const t of [
      "承诺没兑现的方案再想想",
      "说好的做到了吗",
      "应该没问题吧",
      "说话不算话的人多了",
      "先这样",
      "",
      "嗯",
    ]) {
      expect(matchConfirmationUtterance(t), `不应命中：${t}`).toBeNull();
    }
    expect(matchConfirmationUtterance(null as never)).toBeNull();
    expect(matchConfirmationUtterance(42 as never)).toBeNull();
  });

  it("正则清单冻结导出（单一源可审计）", () => {
    expect(PROMISE_CONFIRMATION_KEPT_PATTERNS.length).toBeGreaterThanOrEqual(1);
    expect(PROMISE_CONFIRMATION_BROKEN_PATTERNS.length).toBeGreaterThanOrEqual(2);
  });
});

describe("#41 · 采集 helper（extraction 侧 intake，审查 I3：stamp at）", () => {
  it("仅 user 消息参与；refKey=taskId；timestamp → at（ISO）；无 timestamp → 无 at", () => {
    const items = collectPromiseEvidenceFromExtraction(
      [
        { role: "assistant", content: "承诺兑现了，我核对过" },
        { role: "user", content: "承诺兑现了", timestamp: 1700000000000 },
        { role: "user", content: "今天天气不错" },
      ],
      "task-9",
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "confirmation", verdict: "kept", refKey: "task-9" });
    expect((items[0] as { at?: string }).at).toBe(new Date(1700000000000).toISOString());

    const noTs = collectPromiseEvidenceFromExtraction([{ role: "user", content: "承诺兑现了" }], "task-9");
    expect(noTs).toHaveLength(1);
    expect((noTs[0] as { at?: string }).at).toBeUndefined();

    const noTask = collectPromiseEvidenceFromExtraction(
      [{ role: "user", content: "承诺兑现了", timestamp: 1700000000000 }],
      undefined,
    );
    expect(noTask).toHaveLength(1);
    expect(noTask[0].refKey).toBeUndefined();
  });
});

describe("#41 · evaluatePromiseEvidence（确定性关联+映射+陈旧守卫）", () => {
  const open = (promiseId: string, refKey?: string, createdAt?: string) => ({
    promiseId,
    status: "open",
    refKey,
    ...(createdAt ? { createdAt } : {}),
  });

  it("refKey 严格相等才迁移；映射 confirmation:kept→kept / confirmation:broken→broken", () => {
    const directives = evaluatePromiseEvidence(
      [
        { kind: "confirmation", verdict: "kept", refKey: "task-9" },
        { kind: "confirmation", verdict: "broken", refKey: "task-8" },
      ],
      [open("pm_1", "task-9"), open("pm_2", "task-8")],
    );
    expect(directives).toHaveLength(2);
    expect(directives[0]).toMatchObject({ promiseId: "pm_1", to: "kept" });
    expect(directives[1]).toMatchObject({ promiseId: "pm_2", to: "broken" });
    expect(directives[0].note).toContain("evidence");
  });

  it("工具回执映射：tool_failure→broken / tool_success→kept", () => {
    const directives = evaluatePromiseEvidence(
      [
        { kind: "tool_failure", refKey: "task-9" },
        { kind: "tool_success", refKey: "task-8" },
      ],
      [open("pm_1", "task-9"), open("pm_2", "task-8")],
    );
    expect(directives.map((d) => [d.promiseId, d.to])).toEqual([["pm_1", "broken"], ["pm_2", "kept"]]);
  });

  it("双方任一缺 refKey → 不迁移（宁缺毋滥）", () => {
    expect(evaluatePromiseEvidence([{ kind: "confirmation", verdict: "kept" }], [open("pm_1", "task-9")])).toEqual([]);
    expect(evaluatePromiseEvidence([{ kind: "confirmation", verdict: "kept", refKey: "task-9" }], [open("pm_1")])).toEqual([]);
    expect(evaluatePromiseEvidence([{ kind: "tool_failure", refKey: "task-9" }], [open("pm_1", "task-8")])).toEqual([]);
  });

  it("仅 open promise 参与迁移；同一 promise 多证据首条生效", () => {
    const items = [
      { kind: "confirmation" as const, verdict: "kept" as const, refKey: "task-9" },
      { kind: "tool_failure" as const, refKey: "task-9" },
    ];
    const directives = evaluatePromiseEvidence(items, [
      open("pm_1", "task-9"),
      { promiseId: "pm_2", status: "kept", refKey: "task-9" },
      { promiseId: "pm_3", status: "broken", refKey: "task-9" },
    ]);
    expect(directives).toHaveLength(1);
    expect(directives[0]).toMatchObject({ promiseId: "pm_1", to: "kept" });
  });

  it("陈旧证据守卫（审查 I3）：证据 at < promise.createdAt → 跳过（防毒批重放）", () => {
    const items = [{ kind: "confirmation" as const, verdict: "kept" as const, refKey: "task-9", at: "2026-10-01T00:00:00.000Z" }];
    // promise 建于话语之后 → 该话语不得迁移它
    expect(
      evaluatePromiseEvidence(items, [open("pm_1", "task-9", "2026-10-10T00:00:00.000Z")]),
    ).toEqual([]);
    // 话语晚于建 promise → 正常迁移
    const fresh = evaluatePromiseEvidence(
      [{ kind: "confirmation", verdict: "kept", refKey: "task-9", at: "2026-10-12T00:00:00.000Z" }],
      [open("pm_1", "task-9", "2026-10-10T00:00:00.000Z")],
    );
    expect(fresh).toHaveLength(1);
    expect(fresh[0].promiseId).toBe("pm_1");
  });

  it("缺时间不设防：任一侧缺 at/createdAt → 不启用守卫（照常迁移）", () => {
    const item = { kind: "confirmation" as const, verdict: "kept" as const, refKey: "task-9" };
    expect(evaluatePromiseEvidence([item], [open("pm_1", "task-9", "2026-10-10T00:00:00.000Z")])).toHaveLength(1);
    expect(
      evaluatePromiseEvidence(
        [{ kind: "confirmation", verdict: "kept", refKey: "task-9", at: "2020-01-01T00:00:00.000Z" }],
        [open("pm_1", "task-9")],
      ),
    ).toHaveLength(1);
  });

  it("溯源粒度（审查 M2）：note 带命中正则序号 #pN；at 入 note（审计）", () => {
    const directives = evaluatePromiseEvidence(
      [{ kind: "confirmation", verdict: "kept", patternIndex: 0, refKey: "task-9", at: "2026-10-12T00:00:00.000Z" }],
      [open("pm_1", "task-9")],
    );
    expect(directives[0].note).toContain("#p0");
    expect(directives[0].note).toContain("2026-10-12T00:00:00.000Z");
  });

  it("否定中段不误判 kept（处置轮 RED 探针）：kept 中段排除否定词，否定语义落 broken", () => {
    for (const t of ["说好的没做到", "答应的没有办完", "承诺未兑现"]) {
      const hit = matchConfirmationUtterance(t);
      expect(hit, `应命中 broken：${t}`).not.toBeNull();
      expect(hit!.verdict).toBe("broken");
    }
  });
});

describe("#41 · applyPromiseEvidence（落库 applier，source=evidence）", () => {
  it("逐指令调用 transitionSoulPromise（source=evidence）；list 请求 open+limit=1000（审查 M1）", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const listCalls: Array<Record<string, unknown> | undefined> = [];
    const store = {
      listSoulPromises: (_t: unknown, opts?: Record<string, unknown>) => {
        listCalls.push(opts);
        return [
          { promiseId: "pm_1", status: "open", refKey: "task-9" },
          { promiseId: "pm_2", status: "open", refKey: "task-9" },
        ];
      },
      transitionSoulPromise: (_t: unknown, promiseId: string, to: string, opts?: Record<string, unknown>) => {
        calls.push({ promiseId, to, ...opts });
        return promiseId === "pm_1" ? { ok: true } : { ok: false, reason: "invalid-transition" };
      },
    };
    const result = await applyPromiseEvidence([{ kind: "tool_failure", refKey: "task-9" }], store as never, {
      teamId: "t",
      userId: "u",
      agentId: "a",
    });
    expect(result).toEqual({ applied: 1 });
    expect(listCalls[0]).toMatchObject({ status: "open", limit: 1000 });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ promiseId: "pm_1", to: "broken", source: "evidence" });
    expect(String(calls[0].note)).toContain("evidence");
  });

  it("store 缺实现 → {applied:0}（观测旁路，不抛错）", async () => {
    const result = await applyPromiseEvidence([{ kind: "tool_failure", refKey: "task-9" }], {} as never, {});
    expect(result).toEqual({ applied: 0 });
    expect(await applyPromiseEvidence([{ kind: "tool_failure", refKey: "task-9" }], undefined as never, {})).toEqual({ applied: 0 });
  });
});
