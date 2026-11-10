/**
 * P1-1（结论合并 + 4 个时间戳 + 补读者）的可查判据。临时库，零写生产。
 *
 * 1) 同 (layer, meta.object) 4 条活跃 → 3 条在队 + 1 条被取代（validTo/supersededBy 可查）；
 * 2) object 为空的行（voice 多行）不参与合并；
 * 3) 渲染跳过已失效行，omitted 里出现 reason=superseded；
 * 4) listSoulPersona 默认不含失效行，includeSuperseded:true 全量；
 * 5) 幂等：同一批数据再跑一次不产生新取代与账本行；
 * 6) 存量迁移：validFrom 缺失按 createdAt 回填（不改库）。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../store/sqlite.js";
import { DEFAULT_SOUL_MAINTENANCE_CONFIG, type PersonaItem } from "../types.js";
import { consolidatePersona, freezeItem, orderForRender, renderLayerWithBudget } from "../persona.js";
import { runSoulMaintenance } from "../worker.js";

const T = { teamId: "t-consolidate", userId: "u-consolidate", agentId: "a-consolidate" };
const CREATED = "2026-11-01T00:00:00.000Z";
const NOW = "2026-11-08T02:00:00.000Z";
const NEXT_TICK = "2026-11-08T03:00:00.000Z";

function item(layer: PersonaItem["layer"], id: string, text: string, weight: number, object?: string): PersonaItem {
  return {
    itemId: `${layer}:${id}`,
    layer,
    text,
    state: "active",
    weight,
    evidenceIds: [`ep-${id}`],
    evidenceDays: ["2026-11-01"],
    evidenceOrigins: ["episode"],
    createdAt: CREATED,
    updatedAt: CREATED,
    lastEvidenceAt: CREATED,
    ...(object === undefined ? {} : { meta: { object } }),
  };
}

/** 4 条同对象的关系结论：文本两两不相似，避免被 planMerge 先并掉。 */
function fourRelationship(): PersonaItem[] {
  return [
    item("relationship", "r1", "先取证再改代码", 0.9, "用户"),
    item("relationship", "r2", "答应的事当天做完", 0.8, "用户"),
    item("relationship", "r3", "不许糊弄验收", 0.7, "用户"),
    item("relationship", "r4", "宁可慢也不要假绿", 0.6, "用户"),
  ];
}

describe("consolidatePersona：确定性结论合并", () => {
  it("4 条同 (layer,object) → 3 在队 + 1 被取代，指针指向保留者", () => {
    const plan = consolidatePersona(fourRelationship(), { now: NOW, maxPerObject: 3 });
    expect(plan.superseded).toEqual([
      { itemId: "relationship:r4", by: "relationship:r1", reason: "consolidate:cap" },
    ]);
    const out = (id: string) => plan.items.find((i) => i.itemId === `relationship:${id}`)!;
    const gone = out("r4");
    expect(gone.validTo).toBe(NOW);
    expect(gone.supersededBy).toBe("relationship:r1");
    expect(gone.supersededReason).toBe("consolidate:cap");
    // state 不变：语义由 validTo 承担，复活只需清 validTo
    expect(gone.state).toBe("active");
    expect(gone.updatedAt).toBe(NOW);
    for (const id of ["r1", "r2", "r3"]) expect(out(id).validTo).toBeUndefined();
  });

  it("恰好 3 条不动；上限可覆盖", () => {
    const three = fourRelationship().slice(0, 3);
    expect(consolidatePersona(three, { now: NOW }).superseded).toEqual([]);
    const capped = consolidatePersona(fourRelationship(), { now: NOW, maxPerObject: 2 });
    expect(capped.superseded.map((s) => s.itemId)).toEqual(["relationship:r3", "relationship:r4"]);
  });

  it("object 为空的行（voice 多行）不被合并", () => {
    const voice = [
      item("voice", "v1", "先给结论再给证据", 0.9),
      item("voice", "v2", "不长篇大论", 0.8),
      item("voice", "v3", "宁可短也不要空", 0.7),
      item("voice", "v4", "不用感叹号", 0.6),
    ];
    const plan = consolidatePersona(voice, { now: NOW });
    expect(plan.superseded).toEqual([]);
    expect(plan.items).toEqual(voice);
  });

  it("不同 object 各自成组，不跨对象合并", () => {
    const mixed = [
      item("relationship", "a1", "对他先取证", 0.9, "用户"),
      item("relationship", "a2", "对他别催", 0.8, "用户"),
      item("relationship", "b1", "对事只看证据", 0.9, "验收"),
      item("relationship", "b2", "对事不留情面", 0.8, "验收"),
    ];
    expect(consolidatePersona(mixed, { now: NOW }).superseded).toEqual([]);
  });

  it("幂等：对已合并数据再跑一次，不产生新的取代", () => {
    const once = consolidatePersona(fourRelationship(), { now: NOW });
    const twice = consolidatePersona(once.items, { now: NEXT_TICK });
    expect(twice.superseded).toEqual([]);
    expect(twice.items.find((i) => i.itemId === "relationship:r4")!.validTo).toBe(NOW);
  });
});

describe("渲染：已失效行不参与，omitted 记 superseded", () => {
  it("orderForRender 与 renderLayerWithBudget 都跳过被取代行", () => {
    const plan = consolidatePersona(fourRelationship(), { now: NOW });
    const ordered = orderForRender("relationship", plan.items);
    expect(ordered.map((i) => i.itemId)).toEqual(["relationship:r1", "relationship:r2", "relationship:r3"]);

    const { text, report } = renderLayerWithBudget("relationship", plan.items, DEFAULT_SOUL_MAINTENANCE_CONFIG);
    expect(text).toContain("先取证再改代码");
    expect(text).not.toContain("宁可慢也不要假绿");
    expect(report.rendered).toBe(3);
    const omitted = report.omitted.filter((o) => o.reason === "superseded");
    expect(omitted.map((o) => o.itemId)).toEqual(["relationship:r4"]);
  });

  it("freeze 的 validTo 不冒充 superseded（state 先判）", () => {
    const frozen = freezeItem(item("identity", "i1", "先取证再改代码", 0.8), NOW);
    const report = renderLayerWithBudget("identity", [frozen], DEFAULT_SOUL_MAINTENANCE_CONFIG).report;
    expect(report.omitted.map((o) => o.reason)).toEqual(["frozen"]);
  });
});

describe("store：默认不返回被取代行，审计可全量，validFrom 存量回填", () => {
  it("commit 4 条 → 默认 3 条；includeSuperseded 全量且字段可查", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "soul-consolidate-"));
    const store = new VectorStore(path.join(dir, "vectors.db"), 0);
    try {
      store.init();
      if (store.isDegraded()) throw new Error("临时库初始化降级");

      await store.commitSoulPersona(T, { upsert: fourRelationship(), ledger: [] });
      const all = store.listSoulPersona(T, { includeSuperseded: true });
      expect(all).toHaveLength(4);
      // 存量迁移：库里没有 validFrom，读回必须按 createdAt 回填
      expect(all.every((i) => i.validFrom === CREATED)).toBe(true);

      const plan = consolidatePersona(all, { now: NOW, maxPerObject: 3 });
      await store.commitSoulPersona(T, { upsert: plan.items, ledger: [] });

      const visible = store.listSoulPersona(T);
      expect(visible.map((i) => i.itemId).sort()).toEqual([
        "relationship:r1",
        "relationship:r2",
        "relationship:r3",
      ]);
      const audit = store.listSoulPersona(T, { includeSuperseded: true });
      expect(audit).toHaveLength(4);
      const gone = audit.find((i) => i.itemId === "relationship:r4")!;
      expect(gone.validTo).toBe(NOW);
      expect(gone.supersededBy).toBe("relationship:r1");
      expect(gone.supersededReason).toBe("consolidate:cap");
      expect(gone.validFrom).toBe(CREATED);
      // 保留键不许混进层 meta
      expect(gone.meta).toEqual({ object: "用户" });

      // frozen 仍按原口径默认可见：默认过滤只看 active/degraded + validTo
      const frozen = freezeItem(visible.find((i) => i.itemId === "relationship:r3")!, NOW);
      await store.commitSoulPersona(T, { upsert: [frozen], ledger: [] });
      const withFrozen = store.listSoulPersona(T);
      expect(withFrozen.find((i) => i.itemId === "relationship:r3")!.state).toBe("frozen");

      // 复活口径：清 validTo 就回到默认读回（取代不靠 state，可原地回滚）
      const revived = { ...gone };
      delete revived.validTo;
      await store.commitSoulPersona(T, { upsert: [revived], ledger: [] });
      expect(store.listSoulPersona(T).some((i) => i.itemId === "relationship:r4")).toBe(true);
    } finally {
      try {
        store.close();
      } catch {
        /* 已关闭 */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("worker 接线：tick 内合并一次并落 invalidate 账本", () => {
  it("4 条同对象 → 1 条被取代 + 1 条 invalidate；再跑一次不再新增", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "soul-consolidate-w-"));
    const store = new VectorStore(path.join(dir, "vectors.db"), 0);
    try {
      store.init();
      if (store.isDegraded()) throw new Error("临时库初始化降级");
      const seed = fourRelationship().map((i) => ({
        ...i,
        // 近窗：避免被判成「无新证据」先降级/冻结
        lastEvidenceAt: "2026-11-07T00:00:00.000Z",
      }));
      await store.commitSoulPersona(T, { upsert: seed, ledger: [] });

      const rep = await runSoulMaintenance({
        store,
        tenant: T,
        trigger: "lifecycle",
        now: NOW,
        config: DEFAULT_SOUL_MAINTENANCE_CONFIG,
      });
      expect(rep.consolidated).toBe(1);
      expect(store.listSoulPersona(T)).toHaveLength(3);
      const led = store.listSoulLedger(T, 300);
      const invalidated = led.filter((e) => e.action === "invalidate");
      expect(invalidated).toHaveLength(1);
      expect(invalidated[0]!.gates).toContain("consolidate");
      expect(invalidated[0]!.reason).toContain("合并：同对象超过 3 条");
      expect(invalidated[0]!.itemId).toBe("relationship:r4");

      // 第二次 tick：已失效行不再参与分组 → 无新取代、无新账本行
      const rep2 = await runSoulMaintenance({
        store,
        tenant: T,
        trigger: "lifecycle",
        now: NEXT_TICK,
        config: DEFAULT_SOUL_MAINTENANCE_CONFIG,
      });
      expect(rep2.consolidated).toBeUndefined();
      expect(store.listSoulLedger(T, 300).filter((e) => e.action === "invalidate")).toHaveLength(1);
    } finally {
      try {
        store.close();
      } catch {
        /* 已关闭 */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
