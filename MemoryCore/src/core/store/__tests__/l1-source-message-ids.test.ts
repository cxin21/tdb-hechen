/**
 * L1 行级「原话溯源」字段 source_message_ids 的存储面 RED/GREEN 套件。
 *
 * 背景：MemoryRecord 一直声明 source_message_ids: string[]（l1-writer.ts:89），抽取 prompt
 * 也在产出它，但 SQLite 从来只有 JSONL 侧保留；SQLite 读回被硬编码成 []（l1-reader.ts:80）。
 * 本套件钉住三条契约：
 *  1. 落库：source_message_ids TEXT NOT NULL DEFAULT '[]'（JSON 数组文本），老库走幂等 ALTER；
 *     两处写链（upsertL1 的 stmtUpsertMeta、restoreL1 的 INSERT OR REPLACE）都必须带上它
 *     ——INSERT OR REPLACE 是整行覆盖，漏列=刷空（P0-T3 漏拷家族合同）。
 *  2. 读回：rowToMemoryRecord 解析该列；非法 JSON / 空串 / NULL 一律回落 [] 且不抛。
 *  3. 顺带补齐 rowToMemoryRecord 漏映射的灵魂字段（occurred_at/certainty/source/valence/
 *     arousal/significance/sensitivity/importance/valid_start），空串与 NULL 必须回落到
 *     undefined 而不是 0 / ''（数值 0 是合法值，不能被误当归一化）。
 *
 * 铁律：纯本地 sqlite（临时目录 + dims=0），离线可跑。
 *
 * 注：L1 `source` 列已由 ADR-0025 C2 删除，相关断言移除。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VectorStore } from "../sqlite.js";
import { queryMemoryRecords } from "../../record/l1-reader.js";
import { writeMemory, type ExtractedMemory, type MemoryRecord } from "../../record/l1-writer.js";

const dirs: string[] = [];
const stores: VectorStore[] = [];

// Windows EBUSY：句柄未关即 rmSync 会锁临时文件——afterEach 先 close 再删目录。
afterEach(() => {
  while (stores.length) stores.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function makeStore(): VectorStore {
  const store = new VectorStore(join(tmpDir("l1-smids-"), "vectors.db"), 0);
  stores.push(store);
  const res = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级（环境问题）：${res.reason}`);
  return store;
}

/** 绕过 store API 直接操作底表：模拟存量行 / 脏值，验证读侧容错。 */
const rawDb = (store: VectorStore) =>
  (store as unknown as {
    db: {
      exec(sql: string): void;
      prepare(sql: string): {
        all(...p: unknown[]): unknown[];
        get(...p: unknown[]): unknown;
        run(...p: unknown[]): unknown;
      };
    };
  }).db;

const mkRecord = (id: string, over: Partial<MemoryRecord> = {}): MemoryRecord =>
  ({
    id,
    content: `条目 ${id}`,
    type: "episodic",
    priority: 50,
    scene_name: "trace",
    source_message_ids: [],
    metadata: {},
    timestamps: ["2026-11-01T00:00:00Z"],
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    version: 0,
    sessionKey: "k1",
    sessionId: "s1",
    // overrides LAST（后键胜出）
    ...over,
  }) as MemoryRecord;

const readOne = async (store: VectorStore, id: string): Promise<MemoryRecord> => {
  const rows = await queryMemoryRecords(store, { recordIds: [id] });
  expect(rows).toHaveLength(1);
  return rows[0];
};

describe("source_message_ids 写读往返（writer → SQLite → queryMemoryRecords）", () => {
  it("writer 写一条带 ['m1','m2'] 的记录 → 读回逐位相等", async () => {
    const store = makeStore();
    const memory: ExtractedMemory = {
      content: "用户要求把首页爱心动画从粒子版改成绘制版",
      type: "instruction",
      priority: 80,
      source_message_ids: ["m1", "m2"],
      metadata: {},
      scene_name: "trace",
    };
    const written = await writeMemory({
      memory,
      decision: { record_id: "rt1", action: "store", target_ids: [] },
      baseDir: tmpDir("l1-smids-jsonl-"),
      sessionKey: "k1",
      sessionId: "s1",
      vectorStore: store,
    });
    expect(written?.source_message_ids).toEqual(["m1", "m2"]);

    const got = await readOne(store, "rt1");
    expect(got.source_message_ids).toEqual(["m1", "m2"]);
  });

  it("空数组往返仍为空数组（不落 NULL、不落 'null'）", async () => {
    const store = makeStore();
    store.upsertL1(mkRecord("rt-empty", { source_message_ids: [] }), undefined);
    const got = await readOne(store, "rt-empty");
    expect(got.source_message_ids).toEqual([]);
    const cell = rawDb(store).prepare("SELECT source_message_ids AS v FROM l1_records WHERE record_id = ?").get("rt-empty") as { v: unknown };
    expect(cell.v).toBe("[]");
  });
});

describe("归档→恢复 roundtrip 保值", () => {
  it("archiveL1 → restoreL1 后 source_message_ids 不丢（restore 是 INSERT OR REPLACE 整行覆盖）", async () => {
    const store = makeStore();
    store.upsertL1(mkRecord("arc1", { source_message_ids: ["m7", "m8"] }), undefined);
    expect(store.archiveL1("arc1", "unit-test")).toBe(true);
    expect(await queryMemoryRecords(store, { recordIds: ["arc1"] })).toHaveLength(0);
    expect(store.restoreL1("arc1")).toBe(true);
    const got = await readOne(store, "arc1");
    expect(got.source_message_ids).toEqual(["m7", "m8"]);
  });
});

describe("存量行兼容（老库 ALTER 后的缺省值）", () => {
  it("不走写链、不指定该列的存量行读回空数组", async () => {
    const store = makeStore();
    // 模拟存量行：只给 NOT NULL 的 content，其余列全部吃建表/ALTER 缺省。
    rawDb(store).prepare("INSERT INTO l1_records (record_id, content) VALUES (?, ?)").run("legacy1", "存量记忆");
    const got = await readOne(store, "legacy1");
    expect(got.source_message_ids).toEqual([]);
  });
});

describe("getL1ByIds 读回完整 + 编辑往返不丢（P0：v2 编辑/人工调整链以本方法取行再 upsert）", () => {
  it("getL1ByIds 读回 source_message_ids（解析成 string[]）与灵魂字段", () => {
    const store = makeStore();
    store.upsertL1(
      mkRecord("byid1", {
        source_message_ids: ["m1", "m2"],
        occurred_at: "2026-10-30T00:00:00.000Z",
        valid_start: "2026-10-01T00:00:00.000Z",
        certainty: "inferred",
        valence: 0.25,
        significance: 0.5,
        sensitivity: "finance",
        importance: 6,
      }),
      undefined,
    );
    const rows = store.getL1ByIds(["byid1"]);
    expect(rows).toHaveLength(1);
    expect(rows[0].source_message_ids).toEqual(["m1", "m2"]);
    expect(rows[0].occurred_at).toBe("2026-10-30T00:00:00.000Z");
    expect(rows[0].valid_start).toBe("2026-10-01T00:00:00.000Z");
    expect(rows[0].certainty).toBe("inferred");
    expect(rows[0].valence).toBe(0.25);
    expect(rows[0].significance).toBe(0.5);
    expect(rows[0].sensitivity).toBe("finance");
    expect(rows[0].importance).toBe(6);
  });

  it("编辑往返：getL1ByIds 取行 → 原样重建 → upsert → 再读逐位相等（handleAtomicUpdate 同款）", async () => {
    const store = makeStore();
    store.upsertL1(
      mkRecord("edit1", {
        source_message_ids: ["m1", "m2"],
        occurred_at: "2026-10-31T12:34:56.000Z",
        valid_start: "2026-10-01T00:00:00.000Z",
        certainty: "inferred",
        valence: -0.4,
        arousal: 0.35,
        significance: 0.9,
        sensitivity: "health",
        importance: 7,
      }),
      undefined,
    );
    const row = store.getL1ByIds(["edit1"])[0];
    const rebuilt = {
      id: row.record_id,
      content: "改后的内容",
      type: row.type as MemoryRecord["type"],
      priority: row.priority,
      scene_name: row.scene_name,
      source_message_ids: row.source_message_ids ?? [],
      metadata: JSON.parse(row.metadata_json) as MemoryRecord["metadata"],
      timestamps: [row.timestamp_str],
      createdAt: row.created_time ?? row.timestamp_str,
      updatedAt: "2026-11-04T00:00:00.000Z",
      version: row.version + 1,
      sessionKey: row.session_key,
      sessionId: row.session_id,
      teamId: row.team_id,
      userId: row.user_id,
      agentId: row.agent_id,
      occurred_at: row.occurred_at,
      valid_start: row.valid_start,
      valid_end: row.valid_end,
      certainty: row.certainty as MemoryRecord["certainty"],
      source: row.source,
      valence: row.valence,
      arousal: row.arousal,
      significance: row.significance,
      sensitivity: row.sensitivity,
      importance: row.importance ?? undefined,
    } as MemoryRecord;
    store.upsertL1(rebuilt, undefined);

    const got = await readOne(store, "edit1");
    expect(got.content).toBe("改后的内容");
    expect(got.source_message_ids).toEqual(["m1", "m2"]);
    expect(got.occurred_at).toBe("2026-10-31T12:34:56.000Z");
    expect(got.valid_start).toBe("2026-10-01T00:00:00.000Z");
    expect(got.certainty).toBe("inferred");
    expect(got.valence).toBe(-0.4);
    expect(got.arousal).toBe(0.35);
    expect(got.significance).toBe(0.9);
    expect(got.sensitivity).toBe("health");
    expect(got.importance).toBe(7);
  });
});

describe("老库 ALTER 路径（列不存在 → init 幂等补列）", () => {
  it("加列前的库重新 init → 补列成功，存量行读回 []，新写仍落库", async () => {
    const dbPath = join(tmpDir("l1-smids-legacy-"), "vectors.db");
    const legacy = new VectorStore(dbPath, 0);
    stores.push(legacy);
    legacy.init();
    expect(legacy.isDegraded()).toBe(false);
    // 造「加列前」的库：DROP COLUMN 还原老 schema，再塞一行老数据。
    rawDb(legacy).exec("ALTER TABLE l1_records DROP COLUMN source_message_ids");
    rawDb(legacy).prepare("INSERT INTO l1_records (record_id, content) VALUES (?, ?)").run("old1", "加列前的存量记忆");
    legacy.close();
    stores.pop();

    // 重新打开：init() 的幂等 ALTER 会给老库补列（NOT NULL DEFAULT '[]' 回填老行）。
    const reopened = new VectorStore(dbPath, 0);
    stores.push(reopened);
    reopened.init();
    expect(reopened.isDegraded()).toBe(false);
    expect((await readOne(reopened, "old1")).source_message_ids).toEqual([]);

    reopened.upsertL1(mkRecord("new1", { source_message_ids: ["m9"] }), undefined);
    expect((await readOne(reopened, "new1")).source_message_ids).toEqual(["m9"]);
  });
});

describe("非法值回落（读侧不得抛异常）", () => {
  it("手工 UPDATE 成 'not-json' → 读回 [] 不抛", async () => {
    const store = makeStore();
    store.upsertL1(mkRecord("bad-json", { source_message_ids: ["m1"] }), undefined);
    rawDb(store).prepare("UPDATE l1_records SET source_message_ids = ? WHERE record_id = ?").run("not-json", "bad-json");
    const got = await readOne(store, "bad-json");
    expect(got.source_message_ids).toEqual([]);
  });

  it("空串 → 读回 [] 不抛", async () => {
    const store = makeStore();
    store.upsertL1(mkRecord("empty-str", { source_message_ids: ["m1"] }), undefined);
    rawDb(store).prepare("UPDATE l1_records SET source_message_ids = ? WHERE record_id = ?").run("", "empty-str");
    const got = await readOne(store, "empty-str");
    expect(got.source_message_ids).toEqual([]);
  });

  it("JSON 对象（非数组）→ 读回 [] 不抛", async () => {
    const store = makeStore();
    store.upsertL1(mkRecord("not-array", { source_message_ids: ["m1"] }), undefined);
    rawDb(store).prepare("UPDATE l1_records SET source_message_ids = ? WHERE record_id = ?").run('{"a":1}', "not-array");
    const got = await readOne(store, "not-array");
    expect(got.source_message_ids).toEqual([]);
  });
});

describe("灵魂字段读回映射（rowToMemoryRecord 补齐）", () => {
  it("写 valence/significance/importance/certainty/valid_start 等 → 读回逐位相等", async () => {
    const store = makeStore();
    store.upsertL1(
      mkRecord("soul1", {
        occurred_at: "2026-10-31T12:34:56.000Z",
        valid_start: "2026-10-01T00:00:00.000Z",
        certainty: "inferred",
        valence: -0.4,
        arousal: 0.35,
        significance: 0.9,
        sensitivity: "health",
        importance: 7,
      }),
      undefined,
    );
    const got = await readOne(store, "soul1");
    expect(got.occurred_at).toBe("2026-10-31T12:34:56.000Z");
    expect(got.valid_start).toBe("2026-10-01T00:00:00.000Z");
    expect(got.certainty).toBe("inferred");
    expect(got.valence).toBe(-0.4);
    expect(got.arousal).toBe(0.35);
    expect(got.significance).toBe(0.9);
    expect(got.sensitivity).toBe("health");
    expect(got.importance).toBe(7);
  });

  it("未写灵魂字段 → undefined（不是 0 / ''），数值 0 仍是合法值", async () => {
    const store = makeStore();
    store.upsertL1(mkRecord("soul-empty"), undefined);
    const got = await readOne(store, "soul-empty");
    expect(got.occurred_at).toBeUndefined();
    expect(got.valid_start).toBeUndefined();
    // ADR-0025 C2：L1 `source` 列已删——存量行/新行都不再有该字段（读侧也无第二来源），
    // 故这里恒为 undefined；原「写 msg:m9 → 读回 msg:m9」的往返已随之退场。
    expect(got.source).toBeUndefined();
    expect(got.valence).toBeUndefined();
    expect(got.arousal).toBeUndefined();
    expect(got.significance).toBeUndefined();
    expect(got.importance).toBeUndefined();
    // certainty 是唯一有写入缺省的灵魂列（SOUL_FIELD_DEFAULTS = 'observed'），照实断言。
    expect(got.certainty).toBe("observed");

    store.upsertL1(mkRecord("soul-zero", { valence: 0, arousal: 0, importance: 0 }), undefined);
    const zero = await readOne(store, "soul-zero");
    expect(zero.valence).toBe(0);
    expect(zero.arousal).toBe(0);
    expect(zero.importance).toBe(0);
  });
});
