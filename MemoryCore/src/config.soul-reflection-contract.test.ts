/**
 * #60（S22）：reflection.soulProposals.cardContract 解析（config-first 缺省关，
 * 条件材料化——缺段不带键，沿 shadowCalibration 先例）。
 */
import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

describe("reflection.soulProposals.cardContract 解析（#60 契约门）", () => {
  it("缺省：不带 cardContract 键（逐位现状）", () => {
    const c = parseConfig({ lifecycle: { reflection: { soulProposals: { enabled: true } } } });
    expect((c.lifecycle.reflection.soulProposals as Record<string, unknown>).cardContract).toBeUndefined();
  });

  it("显式 { enabled: true } → 条件材料化", () => {
    const c = parseConfig({
      lifecycle: { reflection: { soulProposals: { enabled: true, cardContract: { enabled: true } } } },
    });
    expect(c.lifecycle.reflection.soulProposals.cardContract).toEqual({ enabled: true });
  });

  it("形状错（非对象）→ 不带键", () => {
    const bad = parseConfig({
      lifecycle: { reflection: { soulProposals: { enabled: true, cardContract: "on" } } },
    } as never);
    expect((bad.lifecycle.reflection.soulProposals as Record<string, unknown>).cardContract).toBeUndefined();
  });
});

describe("reflection.soulProposals.conclusionContract 解析（Batch D · #77 survey F1）", () => {
  it("缺省：不带 conclusionContract 键（逐位现状）", () => {
    const c = parseConfig({ lifecycle: { reflection: { soulProposals: { enabled: true } } } });
    expect((c.lifecycle.reflection.soulProposals as Record<string, unknown>).conclusionContract).toBeUndefined();
  });

  it("显式 { enabled: true } → 条件材料化", () => {
    const c = parseConfig({
      lifecycle: { reflection: { soulProposals: { enabled: true, conclusionContract: { enabled: true } } } },
    });
    expect(c.lifecycle.reflection.soulProposals.conclusionContract).toEqual({ enabled: true });
  });

  it("形状错（非对象）→ 不带键", () => {
    const bad = parseConfig({
      lifecycle: { reflection: { soulProposals: { enabled: true, conclusionContract: "on" } } },
    } as never);
    expect((bad.lifecycle.reflection.soulProposals as Record<string, unknown>).conclusionContract).toBeUndefined();
  });
});
