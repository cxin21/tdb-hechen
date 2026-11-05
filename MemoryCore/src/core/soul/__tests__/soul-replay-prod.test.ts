/**
 * 回放校准（生产数据，只读）——m00527 验收项「判据先过历史数据再上线」。
 *
 * 默认 **skip**：只有显式给 SOUL_REPLAY_DB（指向 vectors.db）才跑，且只以
 * readOnly 打开、只 SELECT core_pending —— 任何写路径不经过这里。
 *
 * 用法：
 *   cd MemoryCore
 *   SOUL_REPLAY_DB=D:/TDB/data/vectors.db pnpm vitest run src/core/soul/__tests__/soul-replay-prod.test.ts
 *
 * 口径：历史上被人驳回（rejected）的提案，判据应 ≥95% 判「非人格」；
 * 判成人格的是 falseAdmits（漏网），必须逐条看，不许用总体达标掩盖。
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { writeFileSync } from "node:fs";
import { replayCalibration, replayStrictCalibration, summarizeReplay, type ReplayCase } from "../replay.js";

const DB = process.env.SOUL_REPLAY_DB;
const AGENT = process.env.SOUL_REPLAY_AGENT ?? "agt-2m7buribzz";

describe.skipIf(!DB)("生产只读回放校准", () => {
  it("core_pending 全量回放：catchRate / falseAdmits / falseRejects", () => {
    const db = new DatabaseSync(DB!, { readOnly: true });
    try {
      const rows = db
        .prepare(
          "SELECT pending_id, content, state, slot FROM core_pending WHERE agent_id = ? ORDER BY created_at ASC",
        )
        .all(AGENT) as Array<{ pending_id: string; content: string; state: string; slot: string }>;
      const cases: ReplayCase[] = rows.map((r) => ({ id: r.pending_id, text: r.content, state: r.state, slot: r.slot }));
      const rep = replayCalibration(cases);
      // eslint-disable-next-line no-console
      console.log("[soul-replay]", summarizeReplay(rep));
      // eslint-disable-next-line no-console
      console.log("[soul-replay] byCode", JSON.stringify(rep.byCode), "states", JSON.stringify(countStates(cases)));
      if (rep.falseAdmits.length) {
        const byId = new Map(cases.map((c) => [c.id, c.text]));
        console.log(
          "[soul-replay] falseAdmits:\n" +
            rep.falseAdmits
              .slice(0, 70)
              .map((c) => `  [${c.layer}] ${(byId.get(c.id) ?? "").replace(/\s+/g, " ").slice(0, 90)}`)
              .join("\n"),
        );
      }
      expect(rep.total).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("严格回放（事件层 + 正向判据）：内容门与出处门分开，逐条理由可落报告", () => {
    const db = new DatabaseSync(DB!, { readOnly: true });
    try {
      const rows = db
        .prepare("SELECT pending_id, content, state, slot FROM core_pending WHERE agent_id = ? ORDER BY created_at ASC")
        .all(AGENT) as Array<{ pending_id: string; content: string; state: string; slot: string }>;
      const cases: ReplayCase[] = rows.map((r) => ({ id: r.pending_id, text: r.content, state: r.state, slot: r.slot }));
      const rep = replayStrictCalibration(cases);
      // eslint-disable-next-line no-console
      console.log(
        "[soul-replay-strict]",
        `rejected=${rep.rejected} contentNonPersona=${rep.contentNonPersona} (${(rep.catchRate * 100).toFixed(1)}%) provenanceOnly=${rep.provenanceOnly} contentAdmits=${rep.contentAdmits} (${(rep.falseAdmitRate * 100).toFixed(1)}%)`,
      );
      // eslint-disable-next-line no-console
      console.log("[soul-replay-strict] byCode", JSON.stringify(rep.byCode));
      // 写明门槛：低于门槛就红，禁止「先上线再观察」。
      expect(rep.catchRate).toBeGreaterThanOrEqual(0.95);
      expect(rep.falseAdmitRate).toBeLessThanOrEqual(0.05);
      const reportPath = process.env.SOUL_REPLAY_REPORT;
      if (reportPath) {
        const lines = [
          "# 严格回放校准报告（生产 core_pending，只读）",
          "",
          `- DB: ${DB}`,
          `- agent: ${AGENT}`,
          `- at: ${new Date().toISOString()}`,
          `- rejected: ${rep.rejected}`,
          `- 内容判非人格: ${rep.contentNonPersona} (${(rep.catchRate * 100).toFixed(1)}%)`,
          `- 仅缺出处: ${rep.provenanceOnly}`,
          `- 内容与出处全过（高危漏网）: ${rep.contentAdmits} (${(rep.falseAdmitRate * 100).toFixed(1)}%)`,
          `- byCode: ${JSON.stringify(rep.byCode)}`,
          "",
          "| id | 内容判定 | 内容失败 | 缺出处 | 理由 |",
          "| --- | --- | --- | --- | --- |",
          ...rep.cases
            .filter((c) => c.state === "rejected")
            .map((c) => `| ${c.id} | ${c.contentPersona ? "像人格" : "非人格"} | ${c.contentCodes.join(",") || "-"} | ${c.provenanceCodes.join(",") || "-"} | ${c.detail.replace(/\|/g, "\\|")} |`),
        ];
        writeFileSync(reportPath, lines.join("\n") + "\n", "utf8");
      }
    } finally {
      db.close();
    }
  });
});

function countStates(cases: ReplayCase[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of cases) out[c.state] = (out[c.state] ?? 0) + 1;
  return out;
}
