/**
 * 标签生命周期（Round18）：长期没被命中的自生长标签要能退役，被新提案命中要能复活。
 * 退役只改 status，不删行——读侧（projectLabels / card endpoint）本来就过滤 dormant。
 */
import { describe, expect, it } from "vitest";

import { emptyAxisVector } from "../traits.js";
import { planStaleLabels } from "../traits.js";
import { resolveLabelProposals, type TraitLabelRow } from "../trait-drift.js";

const NOW = "2026-11-19T00:00:00.000Z";

function row(over: Partial<TraitLabelRow> = {}): TraitLabelRow {
  return {
    label: "先验后报",
    definition: "先跑再报，不先报",
    gloss: "先跑再说",
    anchor: "",
    direction: emptyAxisVector(),
    evidence: 4,
    status: "admitted",
    firstSeen: "2026-09-01T00:00:00.000Z",
    lastSeen: "2026-08-01T00:00:00.000Z",
    aliases: [],
    protocolVersion: "v1",
    ...over,
  };
}

describe("planStaleLabels：标签退役", () => {
  it("超过 60 天没被命中 → dormant；种子/已 dormant 不动", () => {
    const stale = row();
    const fresh = row({ label: "先报后收", lastSeen: "2026-11-10T00:00:00.000Z" });
    const seed = row({ label: "严谨", status: "seed", lastSeen: "2020-01-01T00:00:00.000Z" });
    const dormant = row({ label: "旧标签", status: "dormant", lastSeen: "2020-01-01T00:00:00.000Z" });
    const out = planStaleLabels([stale, fresh, seed, dormant], NOW);
    expect(out.map((r) => r.label)).toEqual(["先验后报"]);
    expect(out[0].status).toBe("dormant");
    // 不删行语义：方向与证据原样带过去，复活不用重算
    expect(out[0].direction).toEqual(stale.direction);
    expect(out[0].evidence).toBe(4);
  });

  it("恰好 60 天不退役，第 60 天零 1 秒才退（边界不可漂移）", () => {
    const exactly = row({ lastSeen: "2026-09-20T00:00:00.000Z" });
    const justOver = row({ lastSeen: "2026-09-19T23:59:59.000Z" });
    expect(planStaleLabels([exactly], NOW)).toHaveLength(0);
    expect(planStaleLabels([justOver], NOW).map((r) => r.label)).toEqual(["先验后报"]);
  });

  it("阈值可调；时间不可解析时不动（宁可少退，不误退）", () => {
    expect(planStaleLabels([row()], NOW, { idleDays: 10 })).toHaveLength(1);
    expect(planStaleLabels([row()], NOW, { idleDays: 120 })).toHaveLength(0);
    expect(planStaleLabels([row({ lastSeen: "not-a-date" })], NOW)).toHaveLength(0);
    expect(planStaleLabels([row()], "not-a-date")).toHaveLength(0);
  });
});

describe("resolveLabelProposals：退役标签被命中即复活", () => {
  it("dormant 行被同方向提案合并 → status 回到 admitted，不新增行", () => {
    const dormant = row({ status: "dormant", lastSeen: "2026-01-01T00:00:00.000Z" });
    const res = resolveLabelProposals(
      [{ label: "先验后报", definition: "另写", direction: emptyAxisVector(), evidenceIds: ["e1", "e2", "e3"] }],
      [dormant],
      { now: NOW },
    );
    expect(res.admitted).toHaveLength(0);
    expect(res.merged).toHaveLength(1);
    expect(res.updated[0].label).toBe("先验后报");
    expect(res.updated[0].status).toBe("admitted");
    expect(res.updated[0].lastSeen).toBe(NOW);
  });
});
