import { describe, expect, it } from "vitest";
import { formatSceneBlock, parseSceneBlock } from "../scene-format.js";

describe("scene-format META 解析不得跨行吞字段", () => {
  it("summary 为空时 heat 必须仍被解析为自己（不得被吞成 summary）", () => {
    const raw = formatSceneBlock({ created: "c", updated: "u", summary: "", heat: 7 }, "正文");
    const parsed = parseSceneBlock(raw, "x.md");
    expect(parsed.meta.summary).toBe("");
    expect(parsed.meta.heat).toBe(7);
  });

  it("summary 为空且 heat=0 时 heat 仍是 0 且 summary 不吞下一行", () => {
    const raw = formatSceneBlock({ created: "c", updated: "u", summary: "", heat: 0 }, "正文");
    const parsed = parseSceneBlock(raw, "x.md");
    expect(parsed.meta.summary).toBe("");
    expect(parsed.meta.heat).toBe(0);
  });

  it("summary 含冒号与空格时原样往返", () => {
    const raw = formatSceneBlock({ created: "c", updated: "u", summary: "结论: 已定案 (M1)", heat: 3 }, "正文");
    const parsed = parseSceneBlock(raw, "x.md");
    expect(parsed.meta.summary).toBe("结论: 已定案 (M1)");
    expect(parsed.meta.heat).toBe(3);
  });

  it("created/updated 为空时不吞后续字段", () => {
    const raw = formatSceneBlock({ created: "", updated: "", summary: "s", heat: 5 }, "正文");
    const parsed = parseSceneBlock(raw, "x.md");
    expect(parsed.meta.created).toBe("");
    expect(parsed.meta.updated).toBe("");
    expect(parsed.meta.summary).toBe("s");
    expect(parsed.meta.heat).toBe(5);
  });
});
