import { describe, expect, it } from "vitest";
import { patchLlmFieldsFromCredential } from "../../scripts/persona-eval/run-persona-eval.js";

/** ADR-0006（#70）：--config llm 段回退补齐——判缺口用 parse 前原始值，防 parseConfig 缺省值伪装。 */
describe("patchLlmFieldsFromCredential（ADR-0006 CLI 回退）", () => {
  const cred = { baseUrl: "http://override.example/v1", apiKey: "ov-key", model: "ov-model" };

  it("raw 无 llm 段（undefined）→ 三字段全补", () => {
    const parsed = { baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-4o" };
    expect(patchLlmFieldsFromCredential(undefined, parsed, cred)).toBe(true);
    expect(parsed).toEqual({ baseUrl: cred.baseUrl, apiKey: cred.apiKey, model: cred.model });
  });

  it("parseConfig 缺省值伪装不拦截回填（regression：openai 缺省 baseUrl 曾与 override key 混搭）", () => {
    const parsed = { baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-4o", timeoutMs: 120000 };
    // raw 里没有这些字段 → 缺省值不可信 → 全补
    expect(patchLlmFieldsFromCredential({}, parsed, cred)).toBe(true);
    expect(parsed.baseUrl).toBe(cred.baseUrl);
    expect(parsed.model).toBe(cred.model);
  });

  it("raw 显式字段保留（显式优先），缺的补", () => {
    const parsed = { baseUrl: "https://explicit.example/v1", apiKey: "", model: "explicit-model" };
    expect(patchLlmFieldsFromCredential({ baseUrl: "https://explicit.example/v1", model: "explicit-model" }, parsed, cred)).toBe(true);
    expect(parsed.baseUrl).toBe("https://explicit.example/v1");
    expect(parsed.model).toBe("explicit-model");
    expect(parsed.apiKey).toBe(cred.apiKey);
  });

  it("raw 全齐 → 不补（false），零改动", () => {
    const parsed = { baseUrl: "https://explicit.example/v1", apiKey: "k", model: "m" };
    expect(patchLlmFieldsFromCredential({ baseUrl: "https://explicit.example/v1", apiKey: "k", model: "m" }, parsed, cred)).toBe(false);
    expect(parsed).toEqual({ baseUrl: "https://explicit.example/v1", apiKey: "k", model: "m" });
  });

  it("maxTokens=0 透传（reasoning 模型不限制），raw 未给时补", () => {
    const parsed = { baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-4o", maxTokens: 4096, timeoutMs: 120000 };
    expect(patchLlmFieldsFromCredential({}, parsed, { ...cred, maxTokens: 0, timeoutMs: 120000 })).toBe(true);
    expect(parsed.maxTokens).toBe(0);
  });

  it("raw 显式 maxTokens 保留；cred 无 maxTokens 不动 parsed", () => {
    const parsed = { baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-4o", maxTokens: 4096, timeoutMs: 120000 };
    expect(patchLlmFieldsFromCredential({ maxTokens: 2048 }, parsed, cred)).toBe(true);
    expect(parsed.maxTokens).toBe(4096);
    const parsed2 = { baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-4o", maxTokens: 4096, timeoutMs: 120000 };
    expect(patchLlmFieldsFromCredential(undefined, parsed2, cred)).toBe(true);
    expect(parsed2.maxTokens).toBe(4096); // cred.maxTokens undefined → 保留 parseConfig 缺省
  });

  it("raw 空串字段视为未设置（isSetCredential 语义）", () => {
    const parsed = { baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-4o" };
    expect(patchLlmFieldsFromCredential({ baseUrl: "", apiKey: "", model: "" }, parsed, cred)).toBe(true);
    expect(parsed.baseUrl).toBe(cred.baseUrl);
  });
});
