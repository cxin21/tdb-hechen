/**
 * P0-1（task-1）L1 读投影完整性 RED→GREEN 套件。
 *
 * 背景（实测）：searchL1Fts 的行类型只列了 8 个 soul 字段（漏 sensitivity），映射处还留着
 * 一个空行（原 `source` 列被删后的残位）；三条 SOUL_SELECT_FRAGMENT 读投影
 * （searchL1ByCoreRefs / searchL1ByScene / searchL1ByType）同样漏 sensitivity，且
 * source_message_ids 从 SELECT 到映射全链缺席。SELECT 侧早已带出列值（SOUL_SELECT_FRAGMENT
 * 含 9 列），所以这是纯投影/映射缺口——数据在库里，读不出来。
 *
 * 铁律：真实临时 SQLite 库（dims=0 → FTS 可用、vec0 不可用），走真 store；不打桩。
 */
import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { VectorStore } from "../sqlite.js";
import type { MemoryRecord } from "../../record/l1-writer.js";

const stores: Array<{ store: VectorStore; dir: string }> = [];

function makeStore(dims = 0): VectorStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l1-projection-"));
  const store = new VectorStore(path.join(dir, "vectors.db"), dims);
  store.init();
  if (store.isDegraded()) throw new Error("临时库初始化降级（环境问题）");
  stores.push({ store, dir });
  return store;
}

const DIM = 8;

/** 8 维正交基（e_i）：cosine 有解析解，相同=1、正交=0。dims=8 时 vec0 可用（实测 caps.vectorSearch=true）。 */
const basis = (i: number): Float32Array => {
  const v = new Float32Array(DIM);
  v[i] = 1;
  return v;
};

afterEach(() => {
  for (const { store, dir } of stores.splice(0)) {
    try {
      store.close();
    } catch {
      /* 无害 */
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows EBUSY 无害 */
    }
  }
});

const mkRecord = (id: string, over: Partial<MemoryRecord> = {}): MemoryRecord =>
  ({
    id,
    content: `alpha 投影探针 ${id}`,
    type: "episodic",
    priority: 50,
    scene_name: "projection-probe",
    source_message_ids: [],
    metadata: {},
    timestamps: ["2026-11-04T00:00:00Z"],
    createdAt: "2026-11-04T00:00:00Z",
    updatedAt: "2026-11-04T00:00:00Z",
    version: 1,
    sessionKey: "k-projection",
    sessionId: "s-projection",
    ...over,
  }) as MemoryRecord;

const SOUL_ROW: Partial<MemoryRecord> = {
  content: "alpha 体检报告 血压偏高",
  sensitivity: "health",
  certainty: "observed",
  valence: -0.4,
  arousal: 0.3,
  significance: 0.8,
  importance: 7,
  source_message_ids: ["l0-msg-a", "l0-msg-b"],
} as Partial<MemoryRecord>;

describe("P0-1 L1 读投影完整性", () => {
  it("searchL1Fts 返回行带 sensitivity 与 source_message_ids", () => {
    const store = makeStore();
    store.upsertL1(mkRecord("r-fts", SOUL_ROW), undefined);

    const rows = store.searchL1Fts("alpha", 5);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.record_id).toBe("r-fts");
    // 本轮缺口：此前该行类型没有 sensitivity，映射是空行 → undefined
    expect(row.sensitivity).toBe("health");
    // 本轮缺口：source_message_ids 从 SELECT 到映射全链缺席
    expect(row.source_message_ids).toEqual(["l0-msg-a", "l0-msg-b"]);
    // 回归钉：既有 soul 字段不能被顺手打掉
    expect(row.importance).toBe(7);
    expect(row.certainty).toBe("observed");
    expect(row.valence).toBeCloseTo(-0.4, 5);
    expect(row.arousal).toBeCloseTo(0.3, 5);
    expect(row.significance).toBeCloseTo(0.8, 5);
  });

  it("searchL1ByType 返回行带 sensitivity 与 source_message_ids", () => {
    const store = makeStore();
    store.upsertL1(mkRecord("r-type", SOUL_ROW), undefined);

    const rows = store.searchL1ByType("episodic", 5);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.sensitivity).toBe("health");
    expect(row.source_message_ids).toEqual(["l0-msg-a", "l0-msg-b"]);
    expect(row.importance).toBe(7);
  });

  // 向量主索引与事实键平行通道此前只有代码级投影，没有运行时断言（dims=0 → vec0 不可用）。
  // dims=8 时 vec0 真实可用，故这里用真库真向量把两条 push 路径钉住。
  it("searchL1Vector 返回行带 sensitivity 与 source_message_ids", () => {
    const store = makeStore(DIM);
    store.upsertL1(mkRecord("r-vec", SOUL_ROW), basis(0));

    const rows = store.searchL1Vector(basis(0), 5);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.record_id).toBe("r-vec");
    expect(row.sensitivity).toBe("health");
    expect(row.source_message_ids).toEqual(["l0-msg-a", "l0-msg-b"]);
    expect(row.importance).toBe(7);
    expect(row.certainty).toBe("observed");
  });

  it("searchL1FactVector 返回行带 sensitivity 与 source_message_ids", () => {
    const store = makeStore(DIM);
    store.upsertL1(mkRecord("r-fact", SOUL_ROW), basis(1));
    expect(store.upsertL1FactVector("r-fact", basis(0))).toBe(true);

    const rows = store.searchL1FactVector(basis(0), 5);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.record_id).toBe("r-fact");
    expect(row.sensitivity).toBe("health");
    expect(row.source_message_ids).toEqual(["l0-msg-a", "l0-msg-b"]);
    expect(row.importance).toBe(7);
    expect(row.certainty).toBe("observed");
  });

  it("searchL1ByScene 返回行带 sensitivity 与 source_message_ids", () => {
    const store = makeStore();
    store.upsertL1(mkRecord("r-scene", SOUL_ROW), undefined);

    const rows = store.searchL1ByScene(["projection-probe"], 5);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.sensitivity).toBe("health");
    expect(row.source_message_ids).toEqual(["l0-msg-a", "l0-msg-b"]);
    expect(row.importance).toBe(7);
  });
});
