/**
 * 56 号（v16-r1 T-03）：upsertValue/listValues 签名三处一致——facade 截断防复发 + 读面透传证明。
 *
 * 缺陷机制（v16 评审 R1 实锚）：
 *   tcvdb.ts:1776 facade upsertValue 仅 7 参、:1781 委托只透传 7 参 → 第 8/9 参
 *   （nodeType/attrs）被 JS 静默截断：anchor-growth 以 9 参调用时 character/attrs
 *   落库丢失（node_type 恒 "theme"、attrs_json 恒 "{}"）= F2 复发机制
 *   （70bb050 只修 sqlite 序列化白名单，未修 facade 截断面）。
 *   读面 tcvdb.ts:1788/:1801 返回类型缺 node_type/attrs_json（运行时透传在、类型面不在，
 *   由 values-signature-character.typeprobe.ts 的 tsc 探针承载）。
 * 测试环境：主库 url 不可达 → _initAsync 内部全 catch（tcvdb.ts:743-753）仅置 degraded 并
 * resolve → _ensureInit 不抛 → 伴生 sqlite（auxPath）照常打开（tcvdb.ts:426/435-454）。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TcvdbMemoryStore } from "../tcvdb.js";
import { VectorStore } from "../sqlite.js";

const TENANT = { teamId: "t1", userId: "u1", agentId: "a1" };
const SILENT = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never;

function makeTcvdb(dir: string): TcvdbMemoryStore {
  return new TcvdbMemoryStore({
    url: "http://127.0.0.1:1", // 主库不可达：只验伴生 sqlite 通路
    username: "test",
    apiKey: "test",
    database: "sigtest",
    embeddingModel: "test-embed",
    timeout: 100,
    auxPath: path.join(dir, "aux.db"),
    logger: SILENT,
  });
}

describe("56 号·tcvdb facade 9 参透传（截断防复发）", () => {
  it("nodeType=character + attrs 经 facade upsertValue → 落库保留（现行 7 参截断=RED）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sig-char-"));
    try {
      const tc = makeTcvdb(dir);
      await tc.init();
      const ok = await tc.upsertValue(
        "c-shounuo", "守诺", 0.5, "auto-growth", TENANT, undefined,
        "auto", "character",
        { source: "self_identity", facts: ["承诺反复被践行", "交付节奏稳定"] },
      );
      expect(ok).toBe(true);
      const rows = await tc.listValues(TENANT);
      const hit = rows.find((r) => r.value_id === "c-shounuo") as { node_type?: string; attrs_json?: string } | undefined;
      expect(hit).toBeDefined();
      expect(hit!.node_type).toBe("character"); // 截断时="theme" → RED 实锤
      const attrs = JSON.parse(hit!.attrs_json ?? "{}");
      expect(attrs.source).toBe("self_identity"); // 截断时=undefined → RED
      expect(attrs.facts).toEqual(["承诺反复被践行", "交付节奏稳定"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("56 号·tcvdb 读面透传（character 行可读回）", () => {
  it("listValues/listValuesAnyState 透传 node_type+attrs_json（伴生库直插 character 行）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sig-read-"));
    try {
      const tc = makeTcvdb(dir);
      await tc.init();
      // 伴生库直插 character 行（绕开 facade 写面，单独验读面委托不筛列）
      const aux = new VectorStore(path.join(dir, "aux.db"), 0);
      aux.init();
      aux.upsertValue("c-zhixing", "知行合一", 0.4, "auto-growth", TENANT, undefined, "auto", "character", { source: "self_identity", facts: ["f1"] });
      const active = await tc.listValues(TENANT);
      const hitA = active.find((r) => r.value_id === "c-zhixing") as { node_type?: string; attrs_json?: string } | undefined;
      expect(hitA?.node_type).toBe("character");
      const anyState = await tc.listValuesAnyState(TENANT);
      const hitS = anyState.find((r) => r.value_id === "c-zhixing") as { node_type?: string; attrs_json?: string } | undefined;
      expect(hitS?.node_type).toBe("character");
      expect(typeof hitS?.attrs_json).toBe("string");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
