/**
 * S6 取数接缝验收：collectIdentityFacts 只读——读完语料 + LLM 提案后返回事实，
 * 不调用任何写方法（旧实现直接 upsertCore identity/self_identity）。
 * 双视角关闭时 self_identity 提案被丢弃；每层上限生效。
 */
import { describe, expect, it, vi } from "vitest";
import { collectIdentityFacts } from "../identity-discovery.js";
import type { IMemoryStore } from "../../store/types.js";

const TENANT = { teamId: "t1", userId: "u1", agentId: "a1" };

function makeStore(rows: Array<Record<string, unknown>>) {
  const store = {
    queryL1Records: vi.fn(() => rows),
    readCore: vi.fn(() => []),
    // 故意提供写方法并断言从未被调用：取数接缝不能借道写库。
    upsertCore: vi.fn(() => true),
  };
  return store as unknown as IMemoryStore & { upsertCore: ReturnType<typeof vi.fn>; queryL1Records: ReturnType<typeof vi.fn> };
}

const ROWS = [
  { record_id: "r1", content: "用户负责 TDB 记忆系统的版本发布与回归验证" },
  { record_id: "r2", content: "用户要求发版前必须先跑全量回归" },
  { record_id: "r3", content: "用户承担生产故障的排查与复盘职责" },
];

const LLM = {
  run: vi.fn(async () =>
    JSON.stringify([
      { slot: "identity", content: "用户负责 TDB 记忆系统的版本发布与回归验证", support: [0], rationale: "反复出现" },
      { slot: "identity", content: "用户承担生产故障的排查与复盘职责", support: [2], rationale: "职责" },
      { slot: "identity", content: "第三条应被每层上限丢掉", support: [1], rationale: "上限" },
      { slot: "self_identity", content: "我承诺每周五输出迭代周报", rationale: "承诺" },
      { slot: "strict_rule", content: "绝不可删除生产记忆记录", rationale: "红线" },
    ]),
  ),
};

describe("collectIdentityFacts（S6 纯取数）", () => {
  it("返回 identity/self_identity 事实，但一次写库都不做", async () => {
    const store = makeStore(ROWS);
    const res = await collectIdentityFacts({ store, tenant: TENANT, llmRunner: LLM as never });
    expect(res.facts.length).toBeGreaterThan(0);
    expect(res.facts.every((f) => f.layer === "identity" || f.layer === "self_identity")).toBe(true);
    expect(res.facts.every((f) => f.evidenceIds.length > 0)).toBe(true);
    expect(store.upsertCore).not.toHaveBeenCalled();
    // strict_rule 提案没有落点（红线走表单 strict_rule 投影），被丢弃。
    expect(res.facts.some((f) => f.text.includes("绝不可删除"))).toBe(false);
  });

  it("双视角关闭 → self_identity 提案被丢弃；每层 ≤ maxPerPass", async () => {
    const store = makeStore(ROWS);
    const res = await collectIdentityFacts({
      store,
      tenant: TENANT,
      llmRunner: LLM as never,
      selfIdentity: { enabled: false, maxPerPass: 1 },
    });
    expect(res.facts.every((f) => f.layer === "identity")).toBe(true);
    expect(res.facts.filter((f) => f.layer === "identity")).toHaveLength(1);
  });

  it("缺 LLM / 缺语料时如实返回 reason，不伪造事实", async () => {
    const store = makeStore([]);
    const noLlm = await collectIdentityFacts({ store, tenant: TENANT });
    expect(noLlm.facts).toHaveLength(0);
    expect(noLlm.reason).toBe("no-llm");
    const noCorpus = await collectIdentityFacts({ store, tenant: TENANT, llmRunner: LLM as never });
    expect(noCorpus.reason).toBe("no-corpus");
    expect(store.queryL1Records).toHaveBeenCalled();
  });

  // S10 补洞（2026-11-07）：清库水位之后没有新语料时，不得拿清库前的 L1 重产事实。
  // 生产实测 06:31 仍有一批 identity reject 引用旧消息（evidence 全是清库前的 m_/rf_ id）。
  it("sinceIso 水位之后无新行 → no-corpus，且不调 LLM", async () => {
    const llm = { run: vi.fn(async () => "[]") };
    const oldRows = ROWS.map((r) => ({ ...r, updated_time: "2026-11-07T05:00:00.000Z" }));
    const store = makeStore(oldRows);
    const res = await collectIdentityFacts({
      store,
      tenant: TENANT,
      llmRunner: llm as never,
      sinceIso: "2026-11-07T06:28:13.834Z",
    });
    expect(res.facts).toHaveLength(0);
    expect(res.reason).toBe("no-corpus");
    expect(llm.run).not.toHaveBeenCalled();
  });

  it("sinceIso 之后的新行照常取数", async () => {
    const freshRows = ROWS.map((r) => ({ ...r, updated_time: "2026-11-07T07:00:00.000Z" }));
    const store = makeStore(freshRows);
    const res = await collectIdentityFacts({
      store,
      tenant: TENANT,
      llmRunner: LLM as never,
      sinceIso: "2026-11-07T06:28:13.834Z",
    });
    expect(res.facts.length).toBeGreaterThan(0);
  });
});
