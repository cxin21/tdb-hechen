/**
 * #18 T11 —— theme 采纳链路 aliases 集成（anchor-growth）。
 * ①提案 aliases 参与证据门（label OR aliases）；②采纳 attrs 落 aliases（≤3，去重域随之变宽）；
 * ③既有锚 attrs.aliases 反向拦截同名提案（变体精确命中 → 不重提）。
 */
import { describe, it, expect, vi } from "vitest";

import { runAnchorGrowth } from "../anchor-growth.js";
import { createGoldenStore, GOLDEN_LOG, GOLDEN_NOW, l1Row, valueRow, scriptedRunner } from "./anchor-lifecycle-golden.fixture.js";

const ROWS = [
  l1Row("t1", "评审要求 防丢数据，先补校验再合入", { significance: 0.9, updated: "2026-10-13T09:00:00Z" }),
  l1Row("t2", "这次事故的教训是 防丢数据 排第一", { updated: "2026-10-13T08:00:00Z" }),
  l1Row("t3", "方案里专门写了 防丢数据 一节", { updated: "2026-10-13T07:00:00Z" }),
  l1Row("t4", "无关填充行", { updated: "2026-10-13T06:00:00Z" }),
];

describe("#18 theme aliases 采纳链路", () => {
  it("label 零命中但 alias 命中 → 证据门过（OR 口径）+ attrs.aliases 落库", async () => {
    const store = createGoldenStore({ rows: ROWS });
    const runner = scriptedRunner({
      "core-values-discover-growth": JSON.stringify([
        { label: "数据完整", rationale: "数据完整性是稳定追求。", aliases: ["防丢数据"], evidenceCount: 3 },
      ]),
    });
    const growth = await runAnchorGrowth({
      store: store as never,
      llmRunner: runner,
      config: { minEvidence: 2 },
      logger: GOLDEN_LOG,
      now: () => GOLDEN_NOW,
    });
    expect(growth.adopted).toBe(1); // 现状（无 aliases 口径）：label「数据完整」0 命中 → 拒
    const up = store.calls.upsertValue.find((c) => c.label === "数据完整");
    expect(up).toBeTruthy();
    expect(up!.nodeType).toBe("theme");
    expect((up!.attrs as { aliases?: string[] }).aliases).toEqual(["防丢数据"]);
  });

  it("既有锚 attrs.aliases 变体命中 → 同名提案拦截（不重提）", async () => {
    // 既有 theme 锚「数据完整」带 alias「防丢数据」（seed active）
    const store = createGoldenStore({
      rows: ROWS,
      values: [valueRow("auto-seed00001", "数据完整", 0.5, { origin: "seed", attrs_json: JSON.stringify({ aliases: ["防丢数据"] }) })],
    });
    const runner = scriptedRunner({
      "core-values-discover-growth": JSON.stringify([
        { label: "防丢数据", rationale: "r", evidenceCount: 3 },
      ]),
    });
    const growth = await runAnchorGrowth({
      store: store as never,
      llmRunner: runner,
      config: { minEvidence: 2 },
      logger: GOLDEN_LOG,
      now: () => GOLDEN_NOW,
    });
    expect(growth.adopted).toBe(0); // 现状：精确 label 去重只认「数据完整」，变体绕过 → 误采纳
  });
});
