/**
 * #41（ADR0003-P3 实施票 C，D8 证据门）· (b) 确定性证据通道单一源测试。
 *
 * 合同（#41 票面验收 + ADR0003 D8）：
 * - 确认话语 = 锚定全句白名单正则（宁缺毋滥：白名单外一律不触发，漏报由 (a)/(c) 兜底）；
 * - 证据项 → 迁移映射确定性：confirmation:kept→kept / confirmation:broken→broken /
 *   tool_failure→broken / tool_success→kept；
 * - 关联 = promise.refKey === 证据 refKey 严格相等（双方缺 refKey → 不迁移，宁缺毋滥）；
 * - 仅 open promise 可被证据迁移；同一 promise 多证据首条生效（状态机单向不变式）；
 * - 采集 helper：仅 user 消息参与确认话语采集（assistant 文本绝不触发）。
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

describe("#41 · 确认话语白名单（锚定全句）", () => {
  it("白名单 kept 命中（前缀+确认词 / 裸确认词 / 验收语）", () => {
    for (const t of [
      "好的，收到",
      "好的，没问题",
      "嗯，确认",
      "ok，已完成",
      "行，就这样定了",
      "收到",
      "确认收到",
      "确认完成",
      "已完成",
      "做完了",
      "没问题",
      "定了",
      "验收通过",
      "同意执行",
      "OK 已完成。",
    ]) {
      const hit = matchConfirmationUtterance(t);
      expect(hit, `应命中 kept：${t}`).not.toBeNull();
      expect(hit!.verdict).toBe("kept");
    }
  });

  it("白名单 broken 命中（直接否定 / 指代否定）", () => {
    for (const t of ["不对", "没做到", "没完成", "失败了", "重做", "返工", "还有问题", "未通过", "这个不对", "这版不行"]) {
      const hit = matchConfirmationUtterance(t);
      expect(hit, `应命中 broken：${t}`).not.toBeNull();
      expect(hit!.verdict).toBe("broken");
    }
  });

  it("白名单之外一律不触发（宁缺毋滥：前缀弱化/后缀续句/疑问均拒绝）", () => {
    for (const t of [
      "确认一下细节",
      "应该没问题吧",
      "没问题的方案是这样",
      "收到了很多消息",
      "确认完成了吗",
      "先这样",
      "好的没问题之后再说",
      "",
      "嗯",
    ]) {
      expect(matchConfirmationUtterance(t), `不应命中：${t}`).toBeNull();
    }
    expect(matchConfirmationUtterance(null as never)).toBeNull();
    expect(matchConfirmationUtterance(42 as never)).toBeNull();
  });

  it("正则清单冻结导出（单一源可审计）", () => {
    expect(PROMISE_CONFIRMATION_KEPT_PATTERNS.length).toBeGreaterThanOrEqual(2);
    expect(PROMISE_CONFIRMATION_BROKEN_PATTERNS.length).toBeGreaterThanOrEqual(1);
  });
});

describe("#41 · 采集 helper（extraction 侧 intake）", () => {
  it("仅 user 消息参与确认话语采集；refKey=taskId；无 taskId → refKey 缺省", () => {
    const items = collectPromiseEvidenceFromExtraction(
      [
        { role: "assistant", content: "确认收到，我这就处理" },
        { role: "user", content: "好的，收到" },
        { role: "user", content: "今天天气不错" },
      ],
      "task-9",
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "confirmation", verdict: "kept", refKey: "task-9" });

    const noTask = collectPromiseEvidenceFromExtraction([{ role: "user", content: "确认收到" }], undefined);
    expect(noTask).toHaveLength(1);
    expect(noTask[0].refKey).toBeUndefined();
  });
});

describe("#41 · evaluatePromiseEvidence（确定性关联+映射）", () => {
  const open = (promiseId: string, refKey?: string) => ({ promiseId, status: "open", refKey });

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
});

describe("#41 · applyPromiseEvidence（落库 applier，source=evidence）", () => {
  it("逐指令调用 transitionSoulPromise（source=evidence）；ok:true 计数、ok:false 不计数", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const store = {
      listSoulPromises: () => [
        { promiseId: "pm_1", status: "open", refKey: "task-9" },
        { promiseId: "pm_2", status: "open", refKey: "task-9" },
      ],
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
