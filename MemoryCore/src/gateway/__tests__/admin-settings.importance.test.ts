/**
 * P1 Task 7 — admin settings get/set 新增段（importancePenalty + worthiness）。
 * 镜像 admin-settings.test.ts 的 rerank 段模式：合并视图、落盘、非法值拒绝。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAdminSettingsRouteTable } from "../admin-settings.js";
import { readSettingsOverride } from "../settings-override.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "core-set-imp-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const deps = () => ({
  baseDir: dir,
  getEffective: () => ({
    llm: { baseUrl: "https://a.b", apiKey: "sk-12345678", model: "m1" },
    embedding: { provider: "openai_compatible", apiKey: "ek-87654321", model: "e1" },
    rerank: { enabled: false, provider: "local", shadowMode: true },
    // P1-T7：生效值（parseMemoryConfig 输出的缺省档）
    importancePenalty: { enabled: false, penalty: 0.3, shadowMode: true },
    worthiness: { extractionEnabled: false },
  }),
  getReindexState: () => ({ status: "idle" as const }),
});

describe("admin settings importancePenalty/worthiness 段（P1 task-7）", () => {
  it("get：无 override 时 source=yaml 且返回 effective 值", async () => {
    const table = makeAdminSettingsRouteTable(deps());
    const res = await table["/v3/admin/settings/get"]!({}, {} as any, "rq-1", {});
    expect(res.code).toBe(0);
    const d = res.data as any;
    expect(d.importancePenalty.enabled).toBe(false);
    expect(d.importancePenalty.penalty).toBe(0.3);
    expect(d.importancePenalty.shadowMode).toBe(true);
    expect(d.importancePenalty.source).toBe("yaml");
    expect(d.worthiness.extractionEnabled).toBe(false);
    expect(d.worthiness.source).toBe("yaml");
  });

  it("get：override 后 source=override 且 override 值并入视图", async () => {
    const table = makeAdminSettingsRouteTable(deps());
    await table["/v3/admin/settings/set"]!({ importancePenalty: { enabled: true } }, {} as any, "rq-2", {});
    const res = await table["/v3/admin/settings/get"]!({}, {} as any, "rq-3", {});
    const d = res.data as any;
    expect(d.importancePenalty.source).toBe("override");
    expect(d.importancePenalty.enabled).toBe(true);
    expect(d.importancePenalty.penalty).toBe(0.3);   // effective 缺省不被局部 override 冲掉
  });

  it("set：importancePenalty 落盘 + 局部 set 不冲掉已存字段", async () => {
    const table = makeAdminSettingsRouteTable(deps());
    await table["/v3/admin/settings/set"]!({ importancePenalty: { enabled: true, penalty: 0.5 } }, {} as any, "rq-4", {});
    await table["/v3/admin/settings/set"]!({ importancePenalty: { shadowMode: false } }, {} as any, "rq-5", {});
    const o = JSON.parse(readFileSync(join(dir, "config-override.json"), "utf-8"));
    expect(o.importancePenalty).toEqual({ enabled: true, penalty: 0.5, shadowMode: false });
  });

  it("set：worthiness.extractionEnabled 落盘", async () => {
    const table = makeAdminSettingsRouteTable(deps());
    await table["/v3/admin/settings/set"]!({ worthiness: { extractionEnabled: true } }, {} as any, "rq-6", {});
    const o = JSON.parse(readFileSync(join(dir, "config-override.json"), "utf-8"));
    expect(o.worthiness).toEqual({ extractionEnabled: true });
  });

  it("set：非法值返回 code!=0 且不落盘", async () => {
    const table = makeAdminSettingsRouteTable(deps());
    const res = await table["/v3/admin/settings/set"]!({ importancePenalty: { enabled: "yes" } }, {} as any, "rq-7", {});
    expect(res.code).not.toBe(0);
    expect(readSettingsOverride(dir)?.importancePenalty).toBeUndefined();
    const res2 = await table["/v3/admin/settings/set"]!({ worthiness: { extractionEnabled: 1 } }, {} as any, "rq-8", {});
    expect(res2.code).not.toBe(0);
    expect(readSettingsOverride(dir)?.worthiness).toBeUndefined();
  });
});
