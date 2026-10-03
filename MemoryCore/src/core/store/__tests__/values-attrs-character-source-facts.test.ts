/**
 * F2（UR-10，2026-10-02 评审裁定）：upsertValue attrs 序列化补 source/facts。
 *
 * 缺陷机制（评审实锚）：character 采纳写 {source:"self_identity",facts:[…]}
 * （anchor-growth.ts:652-655），旧白名单只序列化 role/aliases/description
 * → source/facts 落库即丢弃（"{}"）；identity-discovery.character-tension.test.ts
 * 的 fake store 断言掩盖了此缺陷（测试绿≠落库真）——本测试用真 VectorStore 断言。
 * 附：attrs=undefined 冲突路径不碰 attrs_json（F1 修复所依赖的存储语义护栏）。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../sqlite.js";

function makeStore(): { store: VectorStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "values-char-attrs-"));
  const store = new VectorStore(path.join(dir, "vectors.db"), 0);
  const initRes = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级：${initRes.reason}`);
  return { store, dir };
}

describe("upsertValue attrs.source/facts 持久化（F2 品格采纳通道）", () => {
  it("source+facts 新建 → attrs_json 保留 source/facts", () => {
    const { store, dir } = makeStore();
    try {
      const TENANT = { teamId: "t1", userId: "u1", agentId: "a1" };
      const ok = store.upsertValue(
        "c-shounuo", "守诺", 0.5, "auto-growth", TENANT, undefined,
        "auto", "character",
        { source: "self_identity", facts: ["承诺反复被践行", "交付节奏稳定"] },
      );
      expect(ok).toBe(true);
      const rows = store.listValues(TENANT) as Array<{ value_id: string; node_type: string; attrs_json: string }>;
      const hit = rows.find((r) => r.value_id === "c-shounuo");
      expect(hit).toBeDefined();
      expect(hit!.node_type).toBe("character");
      const attrs = JSON.parse(hit!.attrs_json);
      expect(attrs.source).toBe("self_identity");
      expect(attrs.facts).toEqual(["承诺反复被践行", "交付节奏稳定"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("role/aliases/description/source/facts 五字段同传 → attrs_json 全量保留", () => {
    const { store, dir } = makeStore();
    try {
      const TENANT = { teamId: "t1", userId: "u1", agentId: "a1" };
      store.upsertValue(
        "p-mix", "混合锚", 0.6, "manual", TENANT, 1, "manual", "person",
        { role: "同事", aliases: ["老何"], description: "证据裁决者", source: "self_identity", facts: ["要求附 file:line"] },
      );
      const rows = store.listValues(TENANT) as Array<{ value_id: string; attrs_json: string }>;
      const attrs = JSON.parse(rows.find((r) => r.value_id === "p-mix")!.attrs_json);
      expect(attrs.role).toBe("同事");
      expect(attrs.aliases).toEqual(["老何"]);
      expect(attrs.description).toBe("证据裁决者");
      expect(attrs.source).toBe("self_identity");
      expect(attrs.facts).toEqual(["要求附 file:line"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("冲突路径 attrs=undefined → 原 attrs_json 不被触碰（F1 依赖的存储语义护栏）", () => {
    const { store, dir } = makeStore();
    try {
      const TENANT = { teamId: "t1", userId: "u1", agentId: "a1" };
      store.upsertValue("p-desc", "何晨", 0.3, "auto-growth", TENANT, undefined, "auto", "person", { description: "TDB 负责人" });
      store.upsertValue("p-desc", "何晨", 0.38, "auto-growth", TENANT, undefined, "auto", "person");
      const rows = store.listValues(TENANT) as Array<{ value_id: string; weight: number; attrs_json: string }>;
      const hit = rows.find((r) => r.value_id === "p-desc");
      expect(hit!.weight).toBeCloseTo(0.38, 5);
      const attrs = JSON.parse(hit!.attrs_json);
      expect(attrs.description).toBe("TDB 负责人");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
