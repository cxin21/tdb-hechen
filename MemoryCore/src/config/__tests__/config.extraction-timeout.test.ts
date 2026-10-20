/**
 * 毒批超时解析（L1-OUTAGE-20261015 定罪修复）：memory.extraction.extractionTimeoutMs。
 * 缺省 300_000 = 逐位现状；clamp 60_000..3_600_000。
 */
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../config.js";

const extractionOf = (raw: Record<string, unknown>) => parseConfig({ extraction: raw }).extraction;

describe("memory.extraction.extractionTimeoutMs（毒批超时，config-first）", () => {
  it("缺省 300_000（逐位现状）", () => {
    expect(parseConfig({}).extraction.extractionTimeoutMs).toBe(300_000);
    expect(extractionOf({}).extractionTimeoutMs).toBe(300_000);
  });

  it("显式值原样透传", () => {
    expect(extractionOf({ extractionTimeoutMs: 900_000 }).extractionTimeoutMs).toBe(900_000);
  });

  it("clamp 下限 60s / 上限 1h", () => {
    expect(extractionOf({ extractionTimeoutMs: 1_000 }).extractionTimeoutMs).toBe(60_000);
    expect(extractionOf({ extractionTimeoutMs: 99_999_999 }).extractionTimeoutMs).toBe(3_600_000);
  });
});

describe("memory.extraction.dedupTimeoutMs（#79 dedup 判重超时，config-first）", () => {
  it("缺省 300_000（逐位现状）", () => {
    expect(parseConfig({}).extraction.dedupTimeoutMs).toBe(300_000);
    expect(extractionOf({}).dedupTimeoutMs).toBe(300_000);
  });

  it("显式值原样透传", () => {
    expect(extractionOf({ dedupTimeoutMs: 900_000 }).dedupTimeoutMs).toBe(900_000);
  });

  it("clamp 下限 60s / 上限 1h", () => {
    expect(extractionOf({ dedupTimeoutMs: 1_000 }).dedupTimeoutMs).toBe(60_000);
    expect(extractionOf({ dedupTimeoutMs: 99_999_999 }).dedupTimeoutMs).toBe(3_600_000);
  });
});
