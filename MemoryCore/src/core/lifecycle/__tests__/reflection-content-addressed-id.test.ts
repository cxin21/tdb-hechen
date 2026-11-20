/**
 * Round32 / R31-3 锁：反思结论卡的内容寻址 id 必须幂等。
 *
 * 背景（r31c-a3 复核发现）：reflection.ts 早前用 `rf_<13位ms>_<6位随机>` 生成结论卡 id，
 * 同一条结论每轮反思都新写一行（生产 l1_records 里 1210 条 rf_ 全是旧格式、新式 0 条）。
 * Round28 改成内容寻址（结论正文 sha256 前 16 位）后，只有 upsertL1 覆盖写才幂等；
 * 没有测试锁住这件事，所以「改了但没人验证过」。
 *
 * 本文件用真实 runReflection 跑两轮同一结论、一轮不同结论，断言：
 *  ① id 形如 rf_<16 位 hex>；
 *  ② 同一结论（允许首尾空白/连续空白差异）两轮拿到同一个 id，库里只有 1 行；
 *  ③ sessionId 与 id 同源（reflection-<key>），不再是时间戳会话号；
 *  ④ 不同结论拿到不同 id，库里 2 行。
 */
import { describe, expect, it, vi } from "vitest";
import { runReflection } from "../reflection.js";

const LOG = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
const BASE = "2026-11-19T00:00:00.000Z";

function srcRow(id: string, content: string, at: string) {
  return { id, content, type: "episodic", significance: 1, createdAt: at, updatedAt: at, teamId: "t1", userId: "u1", agentId: "a1", metadata: {} };
}

/** 假 store：upsertL1 按 id 覆盖写（模拟 l1_writer），并把写进去的卡回灌进查询集（= 真实反思史）。 */
function harness(conclusions: string[]) {
  const rows: Array<Record<string, unknown>> = [
    srcRow("r1", "用户坚持先给结论", BASE),
    srcRow("r2", "用户每周五复盘", BASE),
    srcRow("r3", "用户偏好清单式评审", BASE),
  ];
  const cards = new Map<string, Record<string, unknown>>();
  const calls: Array<Record<string, unknown>> = [];
  let turn = 0;
  const store = {
    upsertL1: vi.fn(async (rec: Record<string, unknown>) => {
      calls.push(rec);
      cards.set(String(rec.id), rec);
      const at = String(rec.updatedAt ?? rec.createdAt ?? BASE);
      const existing = rows.findIndex((r) => String(r.id) === String(rec.id));
      const asRow = { ...rec, createdAt: at, updatedAt: at, significance: 0 };
      if (existing >= 0) rows[existing] = asRow;
      else rows.push(asRow);
      return true;
    }),
    addLink: vi.fn(async () => true),
  };
  const llmRunner = {
    run: vi.fn(async () => JSON.stringify([{ question: "沟通模式", conclusion: conclusions[turn++ % conclusions.length], evidence: ["r1"] }])),
  };
  const deps = { queryL1: async () => rows as never, config: { enabled: true, rRef: 0.5 }, store, llmRunner, logger: LOG };
  return { rows, cards, calls, deps };
}

describe("reflection 结论卡：内容寻址 id 幂等", () => {
  it("同一结论两轮 → 同 id、库里 1 行；不同结论 → 不同 id", async () => {
    const h = harness(["用户偏好结论先行的沟通"]);
    const first = await runReflection(h.deps as never);
    expect(first.cardsWritten).toBe(1);
    const id1 = String(h.calls[0].id);
    expect(id1).toMatch(/^rf_[0-9a-f]{16}$/u);
    expect(String(h.calls[0].sessionId)).toBe("reflection-" + id1.slice(3));

    // 第二轮：塞一条比结论卡更新的源行，让触发门通过；结论带首尾空白 + 连续空白。
    const later = new Date(Date.now() + 60_000).toISOString();
    h.rows.push(srcRow("r4", "用户再次要求先给结论", later));
    h.deps.llmRunner.run.mockImplementationOnce(async () =>
      JSON.stringify([{ question: "沟通模式", conclusion: "  用户偏好结论先行的沟通  ", evidence: ["r1"] }]),
    );
    const second = await runReflection(h.deps as never);
    expect(second.cardsWritten).toBe(1);
    expect(String(h.calls[1].id)).toBe(id1);
    expect(h.cards.size).toBe(1);

    // 第三轮：不同结论 → 新 id、库里 2 行。
    h.rows.push(srcRow("r5", "用户改了偏好：要求结论后置", new Date(Date.now() + 120_000).toISOString()));
    h.deps.llmRunner.run.mockImplementationOnce(async () =>
      JSON.stringify([{ question: "沟通模式", conclusion: "用户偏好结论后置的沟通", evidence: ["r1"] }]),
    );
    const third = await runReflection(h.deps as never);
    expect(third.cardsWritten).toBe(1);
    const id3 = String(h.calls[2].id);
    expect(id3).not.toBe(id1);
    expect(h.cards.size).toBe(2);
  });
});
