// tests/config-override.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSettingsOverride, writeSettingsOverride, mergeOverride, maskKey, validateOverride,
} from "../src/config-override.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ks-ovr-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("config-override", () => {
  it("无文件时返回 null", () => {
    expect(readSettingsOverride(dir)).toBeNull();
  });
  it("write 后 read 幂等回读", () => {
    writeSettingsOverride(dir, { llm: { model: "m2" } });
    expect(readSettingsOverride(dir)?.llm?.model).toBe("m2");
  });
  it("mergeOverride：override 优先，未定义字段保留 base", () => {
    const merged = mergeOverride(
      { llm: { model: "m1", maxTokens: 100 }, embedding: { model: "e1", dimensions: 8 } },
      { llm: { model: "m2" }, embedding: { model: "e2" } },
    );
    expect(merged.llm).toEqual({ model: "m2", maxTokens: 100 });
    expect(merged.embedding).toEqual({ model: "e2", dimensions: 8 });
  });
  it("mergeOverride：override 为 null 时原样返回", () => {
    const base = { llm: { model: "m1" }, embedding: { model: "e1" } };
    expect(mergeOverride(base, null)).toEqual(base);
  });
  it("maskKey 只回显 4 位与 hasApiKey", () => {
    expect(maskKey("sk-abcdef")).toEqual({ hasApiKey: true, apiKeyMasked: "****cdef" });
    expect(maskKey(undefined)).toEqual({ hasApiKey: false, apiKeyMasked: "" });
  });
  it("validateOverride 拒绝非法 URL 与非正整数", () => {
    const bad = validateOverride({ llm: { baseUrl: "ftp://x" }, embedding: { dimensions: 0 } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.length).toBe(2);
    const good = validateOverride({ llm: { baseUrl: "https://a.b", model: "m", maxTokens: 10, timeoutMs: 5 }, embedding: { model: "e", dimensions: 8, provider: "openai_compatible", baseUrl: "https://a.b", apiKey: "k" } });
    expect(good.ok).toBe(true);
  });
  it("validateOverride 忽略未提供的段", () => {
    expect(validateOverride({})).toEqual({ ok: true, value: {} });
  });
});
