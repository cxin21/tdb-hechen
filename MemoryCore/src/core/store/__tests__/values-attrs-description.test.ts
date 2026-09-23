/**
 * 立项补丁①（rationale 持久化）存储面 RED：upsertValue attrs 增 description，
 * attrs_json 序列化含 description 且保留 role/aliases。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../sqlite.js";

function makeStore(): { store: VectorStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "values-attrs-"));
  const store = new VectorStore(path.join(dir, "vectors.db"), 0);
  const initRes = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级：${initRes.reason}`);
  return { store, dir };
}

describe("upsertValue attrs.description 持久化（rationale 通道）", () => {
  it("description + role + aliases 同传 → attrs_json 全量保留", () => {
    const { store, dir } = makeStore();
    try {
      const TENANT = { teamId: "t1", userId: "u1", agentId: "a1" };
      const ok = store.upsertValue(
        "root-cause", "根因", 0.8, "agent", TENANT, 1,
        "manual", "theme",
        { description: "所有结论须以真实代码与测试取证背书", role: "同事", aliases: ["小七"] },
      );
      expect(ok).toBe(true);
      const rows = store.listValues(TENANT) as Array<{ value_id: string; attrs_json: string }>;
      const hit = rows.find((r) => r.value_id === "root-cause");
      expect(hit).toBeDefined();
      const attrs = JSON.parse(hit!.attrs_json);
      expect(attrs.description).toBe("所有结论须以真实代码与测试取证背书");
      expect(attrs.role).toBe("同事");
      expect(attrs.aliases).toEqual(["小七"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("只传 description（无 role/aliases）→ 仅 description 落档", () => {
    const { store, dir } = makeStore();
    try {
      const TENANT = { teamId: "t1", userId: "u1", agentId: "a1" };
      store.upsertValue("closed-loop", "闭环", 0.6, "agent", TENANT, 1, "manual", "theme", { description: "每个批次都四态收口" });
      const rows = store.listValues(TENANT) as Array<{ value_id: string; attrs_json: string }>;
      const attrs = JSON.parse(rows.find((r) => r.value_id === "closed-loop")!.attrs_json);
      expect(attrs.description).toBe("每个批次都四态收口");
      expect(attrs.role).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("attrs 不传 → attrs_json='{}'（逐位现状）", () => {
    const { store, dir } = makeStore();
    try {
      const TENANT = { teamId: "t1", userId: "u1", agentId: "a1" };
      store.upsertValue("plain", "普通锚", 0.5, "agent", TENANT, 1, "manual", "theme");
      const rows = store.listValues(TENANT) as Array<{ attrs_json: string }>;
      expect(rows[0].attrs_json).toBe("{}");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
