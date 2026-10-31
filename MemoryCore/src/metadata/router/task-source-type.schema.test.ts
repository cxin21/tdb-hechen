/**
 * #127 · v3 元数据 API（Panel 活路径）source_type 三值契约。
 *
 * 历史数据兼容：库里仍有 github/tapd 历史值，读旧库的调用方也会按旧值重发 ⇒
 * preprocess 归一成 external，schema 层仍只接受 manual|external|other；
 * 非法值 safeParse 失败（v3-meta-router 的 bind 包装 → errorEnvelope(400)）。
 */
import { describe, expect, it } from "vitest";
import { taskCreateSchema, taskUpdateSchema } from "./v3-meta-schemas.js";

const createBody = (sourceType: unknown) => ({
  team_id: "t1",
  creator_user_id: "u1",
  title: "任务",
  ...(sourceType === undefined ? {} : { source_type: sourceType }),
});

describe("#127 v3 task schema · source_type 三值契约", () => {
  it("缺省不传：保持可选（写路径落 manual）", () => {
    const parsed = taskCreateSchema.safeParse(createBody(undefined));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.source_type).toBeUndefined();
  });

  it("新值写入：manual / external / other 原样通过", () => {
    for (const v of ["manual", "external", "other"] as const) {
      const parsed = taskCreateSchema.safeParse(createBody(v));
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.source_type).toBe(v);
    }
  });

  it("旧值读入归一：github / tapd / jira → external（大小写/空白也要吃）", () => {
    for (const legacy of ["github", "tapd", "jira", "TAPD", " GitHub "]) {
      const parsed = taskCreateSchema.safeParse(createBody(legacy));
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.source_type).toBe("external");
    }
    const upd = taskUpdateSchema.safeParse({ task_id: "task-1", source_type: "tapd" });
    expect(upd.success).toBe(true);
    if (upd.success) expect(upd.data.source_type).toBe("external");
  });

  it("非法值 400：枚举外取值被拒（create + update）", () => {
    const bad = taskCreateSchema.safeParse(createBody("bogus"));
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues.some((i) => i.path.join(".") === "source_type")).toBe(true);
    }
    const badUpd = taskUpdateSchema.safeParse({ task_id: "task-1", source_type: "bogus" });
    expect(badUpd.success).toBe(false);
    if (!badUpd.success) {
      expect(badUpd.error.issues.some((i) => i.path.join(".") === "source_type")).toBe(true);
    }
  });
});
