// #11 T5：desc 维护环（GROW-MAINT 证据重算周期顺带评估；缺省关=config-first）。
// 契约：≥2× 基线触发 / desc 缺失直接候选 / per-pass cap（delta 降序）/ LLM 重述+确定性守卫 /
// manual 永不覆盖 / 重述落 attrs 合并保既有键 / reweight 同轮 flush 携带新权重。
import { describe, expect, it } from "vitest";
import { runAnchorGrowth, type AnchorDiscoveryConfig } from "../anchor-growth.js";
import { suggestAnchorWeight } from "../../../gateway/core-values-discover.js";
import { createGoldenStore, GOLDEN_LOG, GOLDEN_NOW, l1Row, scriptedRunner, TENANT, valueRow } from "./anchor-lifecycle-golden.fixture.js";

const GOOD_DESC = "涉及不可逆操作时，宁可先验证再执行，不做直接覆盖。";
const REPLY_OK = JSON.stringify({ description: GOOD_DESC });
const REPLY_EPISODE = "2026-09-01 承诺周报。";

const BASE_CFG: Partial<AnchorDiscoveryConfig> = {
  minEvidence: 5,
  maxPerPass: 2,
  maxTotal: 15,
  maintainIntervalHours: 6,
};

/** 维护轮状态：attempt 冷却内（adoption 不跑）+ maint 到期（7h > 6h）。 */
function maintState(rows: number) {
  const t = new Date(GOLDEN_NOW.getTime() - 30 * 60_000).toISOString();
  return {
    lastAttemptAt: t,
    lastDiscoveryAt: new Date(GOLDEN_NOW.getTime() - 2 * 3600_000).toISOString(),
    lastCorpusCount: rows,
    lastMaintAt: new Date(GOLDEN_NOW.getTime() - 7 * 3600_000).toISOString(),
  };
}

function anchorOpts(extra: Record<string, unknown>) {
  return {
    created_by: "auto-growth",
    origin: "auto" as const,
    state: "active" as const,
    node_type: "theme" as const,
    pinned: 0 as const,
    valence: null,
    ...extra,
  };
}

async function runDescRefresh(seed: { rows: ReturnType<typeof l1Row>[]; values: ReturnType<typeof valueRow>[] }, cfg: Partial<AnchorDiscoveryConfig>, replies: Record<string, string>) {
  const store = createGoldenStore(seed);
  store.setAnchorGrowthState(maintState(seed.rows.length) as never, TENANT);
  const runner = scriptedRunner(replies);
  const result = await runAnchorGrowth({
    store: store as never,
    llmRunner: runner,
    config: { ...BASE_CFG, ...cfg },
    logger: GOLDEN_LOG,
    now: () => GOLDEN_NOW,
  });
  return { store, runner, result };
}

describe("#11 T5 desc 维护环（GROW-MAINT 挂点）", () => {
  it("desc 缺失锚（无基线）→ 立即候选并重述落库（attrs 合同四键）", async () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      l1Row(`r${i}`, i < 10 ? `会话${i}记录：数据安全底线讨论，${i}` : `无关内容 ${i}`, { agentId: "a" }),
    );
    const values = [valueRow("data-safety", "数据安全", 0.4, anchorOpts({ attrs_json: "{}" }))];
    const { store, runner, result } = await runDescRefresh({ rows, values }, { descRefresh: { enabled: true, evidenceMultiple: 2, maxPerPass: 2 } }, { "anchor-desc-refresh": REPLY_OK });
    expect(runner.prompts.filter((p) => p.taskId === "anchor-desc-refresh")).toHaveLength(1);
    expect(result.descRefreshed).toBe(1);
    const up = store.calls.upsertValue.find((c) => c.valueId === "data-safety");
    expect(up).toBeDefined();
    expect(up!.attrs).toEqual({
      description: GOOD_DESC,
      descSource: "auto-refresh",
      lastDescRefreshAt: expect.any(String),
      lastDescRefreshEvidence: 10,
    });
  });

  it("证据 <2× 基线 → 不触发（≥2× 语义守恒）", async () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      l1Row(`r${i}`, i < 9 ? `会话${i}记录：数据安全底线讨论，${i}` : `无关内容 ${i}`, { agentId: "a" }),
    );
    const values = [valueRow("data-safety", "数据安全", suggestAnchorWeight(9, 12), anchorOpts({ attrs_json: JSON.stringify({ description: "旧描述。", lastDescRefreshEvidence: 5 }) }))];
    const { store, runner, result } = await runDescRefresh({ rows, values }, { descRefresh: { enabled: true, evidenceMultiple: 2, maxPerPass: 2 } }, { "anchor-desc-refresh": REPLY_OK });
    expect(runner.prompts.filter((p) => p.taskId === "anchor-desc-refresh")).toHaveLength(0);
    expect(result.descRefreshed).toBe(0);
    expect(store.calls.upsertValue).toHaveLength(0);
  });

  it("per-pass cap：delta 降序择优（3 候选 maxPerPass=2 → 刷 2 个）", async () => {
    const mk = (label: string, hit: number, total: number, base: number) => {
      const rows = Array.from({ length: total }, (_, i) =>
        l1Row(`${label}-r${i}`, i < hit ? `会话${i}记录：${label}相关讨论，${i}` : `无关内容 ${i}`, { agentId: "a" }),
      );
      const ev = hit; // recount = label 子串命中行数
      const v = valueRow(label, label, suggestAnchorWeight(ev, total), anchorOpts({ attrs_json: JSON.stringify({ description: "旧描述。", lastDescRefreshEvidence: base }) }));
      return { rows, v, ev, delta: ev - base };
    };
    const a = mk("数据安全", 10, 14, 2); // delta 8
    const b = mk("交付质量", 8, 14, 4); // delta 4
    const c = mk("复盘纪律", 6, 14, 1); // delta 5
    const rows = [...a.rows, ...b.rows, ...c.rows];
    const values = [a.v, b.v, c.v];
    const { store, runner, result } = await runDescRefresh({ rows, values }, { descRefresh: { enabled: true, evidenceMultiple: 2, maxPerPass: 2 } }, { "anchor-desc-refresh": REPLY_OK });
    expect(result.descRefreshed).toBe(2);
    const refreshed = store.calls.upsertValue.filter((x) => x.attrs?.descSource === "auto-refresh").map((x) => x.valueId);
    expect(refreshed).toEqual(["数据安全", "复盘纪律"]); // delta 8 > 5 > 4：B 被截
    expect(runner.prompts.filter((p) => p.taskId === "anchor-desc-refresh")).toHaveLength(2);
  });

  it("descSource=manual → 永不自动覆盖", async () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      l1Row(`r${i}`, i < 10 ? `会话${i}记录：数据安全底线讨论，${i}` : `无关内容 ${i}`, { agentId: "a" }),
    );
    const values = [valueRow("data-safety", "数据安全", 0.4, anchorOpts({ attrs_json: JSON.stringify({ descSource: "manual" }) }))];
    const { store, runner, result } = await runDescRefresh({ rows, values }, { descRefresh: { enabled: true, evidenceMultiple: 2, maxPerPass: 2 } }, { "anchor-desc-refresh": REPLY_OK });
    expect(runner.prompts.filter((p) => p.taskId === "anchor-desc-refresh")).toHaveLength(0);
    expect(result.descRefreshed).toBe(0);
    expect(store.calls.upsertValue).toHaveLength(0);
  });

  it("LLM 输出不合格（episode 叙述）→ 守卫拦截不落库（宁缺毋滥）", async () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      l1Row(`r${i}`, i < 5 ? `会话${i}记录：数据安全底线讨论，${i}` : `无关内容 ${i}`, { agentId: "a" }),
    );
    const values = [valueRow("data-safety", "数据安全", suggestAnchorWeight(5, 12), anchorOpts({ attrs_json: "{}" }))];
    const { store, runner, result } = await runDescRefresh({ rows, values }, { descRefresh: { enabled: true, evidenceMultiple: 2, maxPerPass: 2 } }, { "anchor-desc-refresh": REPLY_EPISODE });
    expect(runner.prompts.filter((p) => p.taskId === "anchor-desc-refresh")).toHaveLength(1);
    expect(result.descRefreshed).toBe(0);
    expect(store.calls.upsertValue).toHaveLength(0);
  });

  it("重述合并保留既有 attrs 键（person role/aliases）", async () => {
    const rows = Array.from({ length: 14 }, (_, i) =>
      l1Row(`r${i}`, i < 6 ? `周会${i}：老何评审了设计稿，${i}` : `无关内容 ${i}`, { agentId: "a" }),
    );
    const values = [valueRow("p-hechen", "何晨", suggestAnchorWeight(6, 14), anchorOpts({
      node_type: "person",
      attrs_json: JSON.stringify({ role: "同事", aliases: ["老何"], description: "旧描述。", lastDescRefreshEvidence: 2 }),
    }))];
    const { store, result } = await runDescRefresh(
      { rows, values },
      { person: { enabled: true, minEvidence: 5, maxPerPass: 1, maxTotal: 8 }, descRefresh: { enabled: true, evidenceMultiple: 2, maxPerPass: 2 } },
      { "anchor-desc-refresh": REPLY_OK, "person-discover-growth": "[]" },
    );
    expect(result.descRefreshed).toBe(1);
    const up = store.calls.upsertValue.find((c) => c.valueId === "p-hechen");
    expect(up!.attrs).toMatchObject({ role: "同事", aliases: ["老何"], description: GOOD_DESC, descSource: "auto-refresh", lastDescRefreshEvidence: 6 });
  });

  it("reweight 同轮共存：flush 携带新权重（防旧权重回写）", async () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      l1Row(`r${i}`, i < 10 ? `会话${i}记录：数据安全底线讨论，${i}` : `无关内容 ${i}`, { agentId: "a" }),
    );
    const values = [valueRow("data-safety", "数据安全", 0.3, anchorOpts({ attrs_json: JSON.stringify({ description: "旧描述。", lastDescRefreshEvidence: 5 }) }))];
    const { store, result } = await runDescRefresh({ rows, values }, { descRefresh: { enabled: true, evidenceMultiple: 2, maxPerPass: 2 } }, { "anchor-desc-refresh": REPLY_OK });
    expect(result.reweighted).toBe(1);
    expect(result.descRefreshed).toBe(1);
    const ups = store.calls.upsertValue.filter((c) => c.valueId === "data-safety");
    expect(ups).toHaveLength(2);
    expect(ups[0]!.attrs).toBeUndefined(); // reweight 不碰 attrs（F1 教训）
    expect(ups[1]!.weight).toBe(0.4); // flush 用重算后新权重
    expect(ups[1]!.attrs!.description).toBe(GOOD_DESC);
  });

  it("缺省（无 descRefresh 配置）→ 逐位现状：零重述", async () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      l1Row(`r${i}`, i < 10 ? `会话${i}记录：数据安全底线讨论，${i}` : `无关内容 ${i}`, { agentId: "a" }),
    );
    const values = [valueRow("data-safety", "数据安全", 0.4, anchorOpts({ attrs_json: "{}" }))];
    const { store, runner, result } = await runDescRefresh({ rows, values }, {}, { "anchor-desc-refresh": REPLY_OK });
    expect(runner.prompts.filter((p) => p.taskId === "anchor-desc-refresh")).toHaveLength(0);
    expect(result.descRefreshed).toBe(0);
    expect(store.calls.upsertValue).toHaveLength(0);
  });
});
