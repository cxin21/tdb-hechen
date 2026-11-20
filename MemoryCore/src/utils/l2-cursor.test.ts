import { describe, expect, it } from "vitest";

import { l2NextCursor } from "./pipeline-factory.js";

describe("L2 增量游标：任何失败组都不得被跨过（A3 Round19）", () => {
  it("失败组仍有更早的行时，取成功组最大值也会跨过它 → 有失败就停在旧游标", () => {
    const success = [{ updatedAt: "2026-11-01T00:00:09.000Z" }];
    const all = [{ updatedAt: "2026-11-01T00:00:01.000Z" }, { updatedAt: "2026-11-01T00:00:02.000Z" }, ...success];
    expect(l2NextCursor({ cursor: "2026-11-01T00:00:00.000Z", successRows: success, fallbackRows: all, hadFailure: true }))
      .toBe("2026-11-01T00:00:00.000Z");
  });

  it("没有失败组时取成功集最大值（含成功但无正文变化的组）", () => {
    const success = [{ updatedAt: "2026-11-01T00:00:05.000Z" }, { updatedAt: "2026-11-01T00:00:07.000Z" }];
    expect(l2NextCursor({ cursor: "2026-11-01T00:00:00.000Z", successRows: success, fallbackRows: [], hadFailure: false }))
      .toBe("2026-11-01T00:00:07.000Z");
  });

  it("成功集为空且无失败时退回全窗口（旧行为）", () => {
    const all = [{ updatedAt: "2026-11-01T00:00:09.000Z" }];
    expect(l2NextCursor({ cursor: undefined, successRows: [], fallbackRows: all, hadFailure: false }))
      .toBe("2026-11-01T00:00:09.000Z");
  });

  it("首次全量扫描遇失败：不返回任何游标，下一轮仍全量", () => {
    expect(l2NextCursor({ cursor: undefined, successRows: [{ updatedAt: "2026-11-01T00:00:09.000Z" }], fallbackRows: [], hadFailure: true }))
      .toBe("");
  });
});
