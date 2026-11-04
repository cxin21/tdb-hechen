/**
 * 粘性灵魂列（sensitivity / valid_end）与 merge 溯源合并的 RED/GREEN 套件（task-2，P0-2）。
 *
 * 缺陷 A：stmtUpsertMeta 的 ON CONFLICT DO UPDATE 对整行列一律 excluded 覆盖。
 *   - valid_end 被写成 ''（整行重写链不带该字段）→ 已失效的行"复活"；
 *   - sensitivity 被写成 'none'（SOUL_FIELD_DEFAULTS 缺省）→ 健康/财务/关系类记忆降级为可注。
 *   两者都是"旧值被抹"，不是"新值胜出"的问题：调用方这次根本没表达意图。
 *
 * 缺陷 B：l1-writer 的 merge/update 决策会归档 target 旧行并新建一行，新行的
 *   source_message_ids 只带本次抽取的 id、sensitivity 只带本次值 → 旧行的原话证据链
 *   与敏感度在"取代"时静默丢失。溯源只增不减、敏感度取更敏感是契约。
 *
 * 铁律：纯本地 sqlite（临时目录 + dims=0），离线可跑；不碰外部服务。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VectorStore } from "../sqlite.js";
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
  const store = new VectorStore(join(tmpDir("l1-sticky-"), "vectors.db"), 0);
  stores.push(store);
  const res = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级（环境问题）：${res.reason}`);
  return store;
}

/** 绕过 store API 直读底表（主表 / FTS 镜像 / 归档表）。 */
const rawDb = (store: VectorStore) =>
  (
    store as unknown as {
      db: {
        exec(sql: string): void;
        prepare(sql: string): {
          all(...p: unknown[]): unknown[];
          get(...p: unknown[]): unknown;
          run(...p: unknown[]): unknown;
        };
      };
    }
  ).db;

const mkRecord = (id: string, over: Partial<MemoryRecord> = {}): MemoryRecord =>
  ({
    id,
    content: `条目 ${id}`,
    type: "episodic",
    priority: 50,
    scene_name: "sticky",
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

const mainCell = (store: VectorStore, id: string, col: "sensitivity" | "valid_end") =>
  rawDb(store).prepare(`SELECT ${col} AS v FROM l1_records WHERE record_id = ?`).get(id) as { v: unknown } | undefined;

const ftsCell = (store: VectorStore, id: string, col: "sensitivity" | "valid_end") =>
  rawDb(store).prepare(`SELECT ${col} AS v FROM l1_fts WHERE record_id = ?`).get(id) as { v: unknown } | undefined;

describe("缺陷 A-1：sensitivity 是粘性列（整行重写不得把具体类降级）", () => {
  it("二次写不带 sensitivity（缺省 'none'）时 health 不被降级，主表与 FTS 镜像一致", () => {
    const store = makeStore();
    store.upsertL1(mkRecord("sens-nom", { sensitivity: "health" }), undefined);
    store.upsertL1(mkRecord("sens-nom", { content: "改后的内容" }), undefined);

    expect(store.getL1ByIds(["sens-nom"])[0].sensitivity).toBe("health");
    expect(mainCell(store, "sens-nom", "sensitivity")?.v).toBe("health");
    // FTS 镜像是 delete+insert 的整行投影，同样不得写成缺省 'none'
    expect(ftsCell(store, "sens-nom", "sensitivity")?.v).toBe("health");
  });

  it("调用方显式送 'none' 也不得降级（提取侧缺省即 none，与主动降敏不可区分 → 宁可多拦）", () => {
    const store = makeStore();
    store.upsertL1(mkRecord("sens-explicit", { sensitivity: "finance" }), undefined);
    store.upsertL1(mkRecord("sens-explicit", { sensitivity: "none" }), undefined);

    expect(store.getL1ByIds(["sens-explicit"])[0].sensitivity).toBe("finance");
    expect(ftsCell(store, "sens-explicit", "sensitivity")?.v).toBe("finance");
  });

  it("unclassified（fail-closed 最严）不得被 none/空串覆盖为可注", () => {
    const store = makeStore();
    store.upsertL1(mkRecord("sens-unc", { sensitivity: "unclassified" }), undefined);
    store.upsertL1(mkRecord("sens-unc", { content: "改后的内容" }), undefined);
    expect(store.getL1ByIds(["sens-unc"])[0].sensitivity).toBe("unclassified");
  });

  it("升级方向不受粘性影响：库中 none 的行仍可被显式新值改成具体敏感类", () => {
    const store = makeStore();
    store.upsertL1(mkRecord("sens-up", { sensitivity: "none" }), undefined);
    store.upsertL1(mkRecord("sens-up", { sensitivity: "relationship" }), undefined);
    expect(store.getL1ByIds(["sens-up"])[0].sensitivity).toBe("relationship");
    expect(ftsCell(store, "sens-up", "sensitivity")?.v).toBe("relationship");
  });
});

describe("缺陷 A-2：valid_end 是粘性列（已失效行不得被整行重写复活）", () => {
  it("invalidateL1 后二次写不带 valid_end → 主表与 l1_fts 均保留失效时间", () => {
    const store = makeStore();
    const iso = "2026-10-31T00:00:00.000Z";
    store.upsertL1(mkRecord("end1"), undefined);
    expect(store.invalidateL1("end1", iso)).toBe(true);

    // 整行重写（编辑/重要度回写/patch 链同款：不带 valid_end，缺省 ''）
    store.upsertL1(mkRecord("end1", { content: "改后的内容" }), undefined);

    expect(store.getL1ByIds(["end1"])[0].valid_end).toBe(iso);
    expect(mainCell(store, "end1", "valid_end")?.v).toBe(iso);
    // FTS 腿若停留 ''，该行会被下游效期策略当作 active 召回 —— 同一条记忆复活两次
    expect(ftsCell(store, "end1", "valid_end")?.v).toBe(iso);
  });

  it("失效位不是单向锁：新写入显式带 valid_end 时以新值为准", () => {
    const store = makeStore();
    store.upsertL1(mkRecord("end2"), undefined);
    store.upsertL1(mkRecord("end2", { valid_end: "2026-12-31T00:00:00.000Z" }), undefined);
    expect(store.getL1ByIds(["end2"])[0].valid_end).toBe("2026-12-31T00:00:00.000Z");
    expect(ftsCell(store, "end2", "valid_end")?.v).toBe("2026-12-31T00:00:00.000Z");
  });
});

describe("缺陷 B：merge/update 取代旧行时血统（溯源）与敏感度不得丢失", () => {
  const mkMemory = (over: Partial<ExtractedMemory> = {}): ExtractedMemory => ({
    content: "用户要求把首页爱心动画从粒子版改成绘制版",
    type: "instruction",
    priority: 60,
    source_message_ids: ["m2", "m1"],
    metadata: {},
    scene_name: "sticky",
    ...over,
  });

  const merge = async (
    store: VectorStore,
    memory: ExtractedMemory,
    targetIds: string[],
    recordId: string,
    action: "merge" | "update" = "merge",
  ) =>
    writeMemory({
      memory,
      decision: { record_id: recordId, action, target_ids: targetIds },
      baseDir: tmpDir("l1-sticky-jsonl-"),
      sessionKey: "k1",
      sessionId: "s1",
      vectorStore: store,
    });

  it("merge：新行 source_message_ids = 旧行 ∪ 新行（旧在前、去重）", async () => {
    const store = makeStore();
    store.upsertL1(mkRecord("old-a", { source_message_ids: ["m1"] }), undefined);

    const written = await merge(store, mkMemory({ source_message_ids: ["m2", "m1"] }), ["old-a"], "merged-a");

    expect(written?.source_message_ids).toEqual(["m1", "m2"]);
    const row = store.getL1ByIds(["merged-a"])[0];
    expect(row.source_message_ids).toEqual(["m1", "m2"]);
    // 旧行已被归档（合并语义不变）
    expect(store.getL1ByIds(["old-a"])).toHaveLength(0);
  });

  it("merge：多 target 的溯源全部并入（旧在前，逐 target 顺序）", async () => {
    const store = makeStore();
    store.upsertL1(mkRecord("old-b1", { source_message_ids: ["m1"] }), undefined);
    store.upsertL1(mkRecord("old-b2", { source_message_ids: ["m2"] }), undefined);

    const written = await merge(store, mkMemory({ source_message_ids: ["m3"] }), ["old-b1", "old-b2"], "merged-b");

    expect(written?.source_message_ids).toEqual(["m1", "m2", "m3"]);
  });

  it("merge：新记忆未标注敏感度时继承旧行更敏感值（health），不得回落 none", async () => {
    const store = makeStore();
    store.upsertL1(mkRecord("old-c", { sensitivity: "health", source_message_ids: ["m1"] }), undefined);

    await merge(store, mkMemory({ source_message_ids: ["m2"] }), ["old-c"], "merged-c");

    expect(store.getL1ByIds(["merged-c"])[0].sensitivity).toBe("health");
    expect(ftsCell(store, "merged-c", "sensitivity")?.v).toBe("health");
  });

  it("merge：旧 unclassified + 新具体类 → 取新值（fail-closed 特征不阻止明确判定）", async () => {
    const store = makeStore();
    store.upsertL1(mkRecord("old-d", { sensitivity: "unclassified" }), undefined);

    await merge(store, mkMemory({ sensitivity: "finance" }), ["old-d"], "merged-d");

    expect(store.getL1ByIds(["merged-d"])[0].sensitivity).toBe("finance");
  });

  it("update（同款取代语义）同样不丢旧行溯源", async () => {
    const store = makeStore();
    store.upsertL1(mkRecord("old-e", { source_message_ids: ["m9"] }), undefined);

    const written = await merge(store, mkMemory({ source_message_ids: ["m10"] }), ["old-e"], "updated-e", "update");

    expect(written?.source_message_ids).toEqual(["m9", "m10"]);
  });
});

describe("回归护栏：归档→恢复往返仍保值（INSERT OR REPLACE 整行覆盖）", () => {
  it("失效 + 敏感行 archive → restore 后 valid_end / sensitivity 逐位保留", () => {
    const store = makeStore();
    const iso = "2026-10-31T00:00:00.000Z";
    store.upsertL1(mkRecord("arc1", { sensitivity: "relationship" }), undefined);
    expect(store.invalidateL1("arc1", iso)).toBe(true);
    expect(store.archiveL1("arc1", "unit-test")).toBe(true);
    expect(store.restoreL1("arc1")).toBe(true);

    const row = store.getL1ByIds(["arc1"])[0];
    expect(row.valid_end).toBe(iso);
    expect(row.sensitivity).toBe("relationship");
  });
});
