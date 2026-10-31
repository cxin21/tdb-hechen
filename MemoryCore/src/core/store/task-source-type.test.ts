/**
 * #127 · TaskSourceType 三值契约（manual|external|other）——归一/兼容矩阵。
 *
 * 契约：
 *  - 写边界只产出三值（历史值 github|tapd|jira 归一到 external）；
 *  - 非法值不在这里「修正」成合法值：canonicalize 原样放行交给 z.enum 拒（→400）；
 *  - 读边界 fail-safe：库里任何非三值（含 null / 脏数据）一律读成 other，不把非法值漏给上层。
 */
import { describe, expect, it } from "vitest";
import {
  LEGACY_TASK_SOURCE_TYPE_ALIASES,
  TASK_SOURCE_TYPES,
  canonicalizeTaskSourceTypeInput,
  normalizeTaskSourceType,
} from "./task-source-type.js";

describe("#127 TaskSourceType 三值契约", () => {
  it("枚举只有三值", () => {
    expect([...TASK_SOURCE_TYPES]).toEqual(["manual", "external", "other"]);
  });

  it("历史别名表：github/tapd/jira → external（同源单一事实）", () => {
    expect(LEGACY_TASK_SOURCE_TYPE_ALIASES).toEqual({ github: "external", tapd: "external", jira: "external" });
    expect(Object.isFrozen(LEGACY_TASK_SOURCE_TYPE_ALIASES)).toBe(true);
  });

  it("canonicalize（写边界）：旧值归一为 external，三值原样", () => {
    expect(canonicalizeTaskSourceTypeInput("github")).toBe("external");
    expect(canonicalizeTaskSourceTypeInput("tapd")).toBe("external");
    expect(canonicalizeTaskSourceTypeInput("jira")).toBe("external");
    expect(canonicalizeTaskSourceTypeInput("  GitHub ")).toBe("external");
    expect(canonicalizeTaskSourceTypeInput("TAPD")).toBe("external");
    expect(canonicalizeTaskSourceTypeInput("manual")).toBe("manual");
    expect(canonicalizeTaskSourceTypeInput("EXTERNAL")).toBe("external");
    expect(canonicalizeTaskSourceTypeInput("other")).toBe("other");
  });

  it("canonicalize 不吞非法值：原样交给 z.enum 拒（→400），非字符串不炸", () => {
    expect(canonicalizeTaskSourceTypeInput("bogus")).toBe("bogus");
    expect(canonicalizeTaskSourceTypeInput("")).toBe("");
    expect(canonicalizeTaskSourceTypeInput(42)).toBe(42);
    expect(canonicalizeTaskSourceTypeInput(null)).toBe(null);
    expect(canonicalizeTaskSourceTypeInput(undefined)).toBe(undefined);
  });

  it("normalize（读边界）：旧值→external，三值直通，脏值→other", () => {
    expect(normalizeTaskSourceType("github")).toBe("external");
    expect(normalizeTaskSourceType("tapd")).toBe("external");
    expect(normalizeTaskSourceType("jira")).toBe("external");
    expect(normalizeTaskSourceType("Jira")).toBe("external");
    expect(normalizeTaskSourceType("manual")).toBe("manual");
    expect(normalizeTaskSourceType("external")).toBe("external");
    expect(normalizeTaskSourceType("other")).toBe("other");
    // 读侧 fail-safe：脏数据不抛错、不把非法值漏给上层
    expect(normalizeTaskSourceType("bogus")).toBe("other");
    expect(normalizeTaskSourceType("")).toBe("other");
    expect(normalizeTaskSourceType(null)).toBe("other");
    expect(normalizeTaskSourceType(undefined)).toBe("other");
    expect(normalizeTaskSourceType(7)).toBe("other");
  });
});
