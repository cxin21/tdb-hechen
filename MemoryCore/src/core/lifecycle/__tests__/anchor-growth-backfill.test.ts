/**
 * #9 T3 —— 采纳副作用（coreRefs/personRefs 回填）收口。
 *
 * 契约（p09 方案）：
 *  1. 回填经 Promise.resolve + Promise.allSettled 批量等待——store 返回 Promise 时
 *     rejection 不得成为 unhandled rejection，更不得中断 runAnchorGrowth；
 *  2. 失败（rejected / false）计数进结构化 warn（backfillOk/BackfillFail），可观测；
 *  3. 命中口径不变：theme=label 子串包含；person=label/alias 任一子串包含。
 */
import { describe, expect, it, vi } from "vitest";

import { runAnchorGrowth } from "../anchor-growth.js";
import { createGoldenStore, GOLDEN_LOG, GOLDEN_NOW, l1Row, scriptedRunner } from "./anchor-lifecycle-golden.fixture.js";

const ROWS = [
  l1Row("b1", "回滚预案：先写回滚步骤再上线。", { significance: 0.9, updated: "2026-10-13T09:00:00Z" }),
  l1Row("b2", "回滚预案演练通过。", { updated: "2026-10-13T08:00:00Z" }),
  l1Row("b3", "回滚预案评审补了数据分支。", { updated: "2026-10-13T07:00:00Z" }),
  l1Row("b4", "回滚预案写进发布单了。", { updated: "2026-10-13T06:00:00Z" }),
  l1Row("b5", "回滚预案这次真用上了。", { updated: "2026-10-13T05:00:00Z" }),
  l1Row("b6", "无关填充行，避免语料歧义。", { updated: "2026-10-13T04:00:00Z" }),
];

function themeRunner(): ReturnType<typeof scriptedRunner> {
  return scriptedRunner({
    "core-values-discover-growth": JSON.stringify([
      { label: "回滚预案", rationale: "回滚预案是上线前的强制步骤。", evidenceCount: 5 },
    ]),
  });
}

describe("#9 T3：采纳副作用回填收口（allSettled + 结构化计数）", () => {
  it("theme 采纳 → 命中行 coreRefs 回填被调用（命中=label 子串）", async () => {
    const store = createGoldenStore({ rows: ROWS });
    const growth = await runAnchorGrowth({
      store: store as never,
      llmRunner: themeRunner(),
      config: { minEvidence: 2 },
      logger: GOLDEN_LOG,
      now: () => GOLDEN_NOW,
    });
    expect(growth.adopted).toBe(1);
    const hitRows = store.calls.backfillCoreRef.map((c) => c.recordId).sort();
    expect(hitRows).toEqual(["b1", "b2", "b3", "b4", "b5"]);
    expect(store.calls.backfillCoreRef.every((c) => c.label === "回滚预案")).toBe(true);
  });

  it("backfill 返回 rejected Promise → run 不炸、结果完整、warn 带 fail 计数", async () => {
    const store = createGoldenStore({ rows: ROWS, backfillMode: "reject" });
    const warns: string[] = [];
    const logger = { ...GOLDEN_LOG, warn: (m: string) => { warns.push(String(m)); } };
    const growth = await runAnchorGrowth({
      store: store as never,
      llmRunner: themeRunner(),
      config: { minEvidence: 2 },
      logger: logger as typeof GOLDEN_LOG,
      now: () => GOLDEN_NOW,
    });
    expect(growth.adopted).toBe(1); // 采纳不受回填失败影响
    expect(growth.ran).toBe(true);
    const backfillWarns = warns.filter((m) => m.includes("backfill"));
    expect(backfillWarns.length).toBeGreaterThan(0);
    expect(backfillWarns.some((m) => m.includes("fail=5"))).toBe(true);
  });

  it("backfill 返回 false → 计数 warn（ok=0 fail=N），不误报成功", async () => {
    const store = createGoldenStore({ rows: ROWS, backfillMode: "false" });
    const warns: string[] = [];
    const logger = { ...GOLDEN_LOG, warn: (m: string) => { warns.push(String(m)); } };
    await runAnchorGrowth({
      store: store as never,
      llmRunner: themeRunner(),
      config: { minEvidence: 2 },
      logger: logger as typeof GOLDEN_LOG,
      now: () => GOLDEN_NOW,
    });
    expect(warns.some((m) => m.includes("backfill") && m.includes("fail=5") && m.includes("ok=0"))).toBe(true);
  });

  it("全部成功 → 不产生 backfill warn（宁缺毋滥）", async () => {
    const store = createGoldenStore({ rows: ROWS });
    const warns: string[] = [];
    const logger = { ...GOLDEN_LOG, warn: (m: string) => { warns.push(String(m)); } };
    await runAnchorGrowth({
      store: store as never,
      llmRunner: themeRunner(),
      config: { minEvidence: 2 },
      logger: logger as typeof GOLDEN_LOG,
      now: () => GOLDEN_NOW,
    });
    expect(warns.filter((m) => m.includes("backfill"))).toHaveLength(0);
  });

  it("person 采纳 → personRefs 回填收口同款（rejected 不炸）", async () => {
    const store = createGoldenStore({ rows: ROWS, backfillMode: "reject" });
    const warns: string[] = [];
    const logger = { ...GOLDEN_LOG, warn: (m: string) => { warns.push(String(m)); } };
    const runner = scriptedRunner({
      // person 分支在 theme 调用之后——theme 空提案（"[]"）不采纳，让 person 分支执行。
      "core-values-discover-growth": "[]",
      "person-discover-growth": JSON.stringify([
        { label: "回滚预案", role: "同事", aliases: ["老回"], description: "发布流程把关人。" },
      ]),
    });
    const growth = await runAnchorGrowth({
      store: store as never,
      llmRunner: runner,
      config: { minEvidence: 2, person: { enabled: true, minEvidence: 2, maxPerPass: 1, maxTotal: 8 } },
      logger: logger as typeof GOLDEN_LOG,
      now: () => GOLDEN_NOW,
    });
    expect(growth.adopted).toBe(1);
    expect(store.calls.backfillMemoryRef.some((c) => c.key === "personRefs")).toBe(true);
    expect(warns.some((m) => m.includes("personRefs") && m.includes("fail="))).toBe(true);
  });

  it("#13 T7：theme 回填触发大小写不敏感（与 recount/personEvCount 同刻度）", async () => {
    // 证据门 recount 双侧 lowercase（英文 label「rollback plan」命中「Rollback Plan approved」），
    // 但回填触发 content.includes(label) 是大小写敏感 → 同一行证据被采纳计数却不回填 =
    // 证据↔引用断链。触发口径对齐（CJK 无大小写，逐位不受影响）。
    const rows = [
      l1Row("cA", "Rollback Plan approved today", { significance: 0.9, updated: "2026-10-13T09:00:00Z" }),
      l1Row("cB", "rollback plan again", { updated: "2026-10-13T08:00:00Z" }),
      l1Row("cC", "unrelated filler", { updated: "2026-10-13T07:00:00Z" }),
    ];
    const store = createGoldenStore({ rows });
    const runner = scriptedRunner({
      "core-values-discover-growth": JSON.stringify([
        { label: "rollback plan", rationale: "发布必须先写回滚方案。", evidenceCount: 2 },
      ]),
    });
    const growth = await runAnchorGrowth({
      store: store as never,
      llmRunner: runner,
      config: { minEvidence: 2 },
      logger: GOLDEN_LOG,
      now: () => GOLDEN_NOW,
    });
    expect(growth.adopted).toBe(1); // 证据门已 lowercase（recount），采纳不受影响
    const hitRows = store.calls.backfillCoreRef.map((c) => c.recordId).sort();
    expect(hitRows).toEqual(["cA", "cB"]); // 现状漏 cA（大小写敏感）
  });

  it("#13 T7：person 回填触发大小写不敏感（alias 口径对齐 personEvCount）", async () => {
    const rows = [
      l1Row("pA", "ALICE said hi", { significance: 0.9, updated: "2026-10-13T09:00:00Z" }),
      l1Row("pB", "al wrote a note", { updated: "2026-10-13T08:00:00Z" }),
    ];
    const store = createGoldenStore({ rows });
    const runner = scriptedRunner({
      "core-values-discover-growth": "[]",
      "person-discover-growth": JSON.stringify([
        { label: "Alice", role: "同事", aliases: ["al"], description: "协作同学。" },
      ]),
    });
    const growth = await runAnchorGrowth({
      store: store as never,
      llmRunner: runner,
      config: { minEvidence: 2, person: { enabled: true, minEvidence: 2, maxPerPass: 1, maxTotal: 8 } },
      logger: GOLDEN_LOG,
      now: () => GOLDEN_NOW,
    });
    expect(growth.adopted).toBe(1); // personEvCount 已双侧 lower（#15）
    const hits = store.calls.backfillMemoryRef.filter((c) => c.key === "personRefs").map((c) => c.recordId).sort();
    expect(hits).toEqual(["pA", "pB"]); // 现状漏 pA（大小写敏感）
  });
});
