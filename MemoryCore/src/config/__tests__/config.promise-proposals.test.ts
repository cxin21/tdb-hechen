/**
 * #44（ADR0003 D8 · (c) LLM 提议通道调度面，2026-10-17）：promise 提案桥接开关解析。
 *
 * 合同（D-44-3）：lifecycle.reflection.promiseProposals.enabled——
 * 与 soulProposals.enabled 同 section 同范式（lifecycle.reflection 顶层组，独立开关独立灰度）；
 * 缺省 false=逐位现状（零提示词改动、零 store 调用、零提案）；非布尔真值（如 "yes"）不接受=缺省关。
 */
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../config.js";

const reflectionOf = (raw: Record<string, unknown>) => parseConfig({ lifecycle: { reflection: raw } }).lifecycle.reflection;

describe("lifecycle.reflection.promiseProposals.enabled（#44 提案调度面，config-first）", () => {
  it("缺省 false（逐位现状）", () => {
    expect(parseConfig({}).lifecycle.reflection.promiseProposals.enabled).toBe(false);
    expect(reflectionOf({}).promiseProposals.enabled).toBe(false);
  });

  it("显式 true 透传", () => {
    expect(reflectionOf({ promiseProposals: { enabled: true } }).promiseProposals.enabled).toBe(true);
  });

  it("非布尔真值不接受（缺省关）", () => {
    expect(reflectionOf({ promiseProposals: { enabled: "yes" } }).promiseProposals.enabled).toBe(false);
  });
});
