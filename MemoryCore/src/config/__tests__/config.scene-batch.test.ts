/**
 * #46 毒批拆分+批次上限解析：memory.extraction.scenePoisonSplit / sceneBatchMaxChars。
 * 缺省关（false / 0）= 逐位现状；config-first。
 */
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../config.js";

const extractionOf = (raw: Record<string, unknown>) => parseConfig({ extraction: raw }).extraction;

describe("memory.extraction.scenePoisonSplit / sceneBatchMaxChars（#46 毒批拆分，config-first）", () => {
  it("缺省关：false / 0（逐位现状）", () => {
    expect(parseConfig({}).extraction.scenePoisonSplit).toBe(false);
    expect(parseConfig({}).extraction.sceneBatchMaxChars).toBe(0);
    expect(extractionOf({}).scenePoisonSplit).toBe(false);
    expect(extractionOf({}).sceneBatchMaxChars).toBe(0);
  });

  it("显式开启与覆盖", () => {
    expect(extractionOf({ scenePoisonSplit: true }).scenePoisonSplit).toBe(true);
    expect(extractionOf({ sceneBatchMaxChars: 12_000 }).sceneBatchMaxChars).toBe(12_000);
  });

  it("非法值兜底：非布尔→false、负数→0", () => {
    expect(extractionOf({ scenePoisonSplit: "yes" }).scenePoisonSplit).toBe(false);
    expect(extractionOf({ sceneBatchMaxChars: -5 }).sceneBatchMaxChars).toBe(0);
  });
});
