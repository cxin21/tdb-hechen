/**
 * 存量槽导入预览（只读，生产库）：不写任何表，只回答「开启人格层后，第一轮会把什么
 * 认成人格、什么被打回 method、预算会砍掉哪几条」。
 *
 * 用法：
 *   cd MemoryCore
 *   $env:SOUL_PREVIEW_DB="D:/TDB/data/vectors.db"; $env:SOUL_PREVIEW_AGENT="agt-...";
 *   pnpm vitest run src/core/soul/__tests__/soul-import-preview.test.ts
 *
 * 缺 SOUL_PREVIEW_DB 时整组跳过（默认不在常规门里连生产库）。
 */
import { describe, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { planConsolidation } from "../consolidator.js";
import { renderLayerWithBudget } from "../persona.js";
import { DEFAULT_SOUL_MAINTENANCE_CONFIG, INJECTED_LAYERS } from "../types.js";

const DB = process.env.SOUL_PREVIEW_DB ?? "";
const AGENT = process.env.SOUL_PREVIEW_AGENT ?? "agt-2m7buribzz";

describe.skipIf(!DB)("生产只读预览：存量槽导入人格层", () => {
  it("打印逐层准入/打回/预算省略", () => {
    const db = new DatabaseSync(DB, { readOnly: true });
    const rows = db
      .prepare("SELECT slot, content, version, source FROM core_memory WHERE agent_id = ?")
      .all(AGENT) as Array<{ slot: string; content: string; version: number; source: string }>;
    db.close();

    const pick = (slot: string): string => rows.find((r) => r.slot === slot)?.content ?? "";
    const slots = {
      identity: pick("identity"),
      selfIdentity: pick("self_identity"),
      strictRule: pick("strict_rule"),
      coreValue: pick("core_value"),
    };
    console.log(
      "[soul-preview] 槽：" +
        rows
          .map((r) => `${r.slot}=v${r.version}/${String(r.content ?? "").length}字/${r.source}`)
          .join(" "),
    );

    const plan = planConsolidation({
      slots,
      existing: [],
      now: new Date().toISOString(),
      config: DEFAULT_SOUL_MAINTENANCE_CONFIG,
    });

    const byLayer: Record<string, number> = {};
    for (const it of plan.items) byLayer[it.layer] = (byLayer[it.layer] ?? 0) + 1;
    console.log(`[soul-preview] admitted=${plan.admitted.length} rejected=${plan.rejected.length} byLayer=${JSON.stringify(byLayer)}`);

    for (const layer of ["boundary", "identity", "values", "relationship", "voice", "narrative", "method"]) {
      for (const it of plan.items.filter((i) => i.layer === layer)) console.log(`  [${layer}] ${it.text}`);
    }
    console.log("[soul-preview] rejected:");
    for (const r of plan.rejected) console.log(`  (${r.layer ?? "null"}) ${r.codes.join(",")} | ${r.text.slice(0, 90)}`);

    // 渲染面：注入层逐层过预算（boundary 免裁剪），打印实际注入字数与省略清单。
    let injectedTotal = 0;
    for (const layer of INJECTED_LAYERS) {
      const r = renderLayerWithBudget(layer, plan.items, DEFAULT_SOUL_MAINTENANCE_CONFIG);
      if (r.text.length === 0) continue;
      injectedTotal += r.text.length;
      console.log(
        `[soul-preview] render ${layer}: ${r.text.length}字 渲染${r.report.rendered} 省略${r.report.omitted.length} (${r.report.usedChars}/${r.report.budgetChars})`,
      );
      for (const o of r.report.omitted) console.log(`    omit ${o.itemId} ${o.chars}字 reason=${o.reason}`);
    }
    console.log(`[soul-preview] 注入总字数=${injectedTotal}`);
  });
});
