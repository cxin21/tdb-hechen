/**
 * OpenCode Go 客户端标识头（host 作用域）单元测试。
 * 语义：仅 opencode.ai 端点附加 UA + x-opencode-session；其他供应商零额外头。
 */
import { describe, it, expect } from "vitest";
import { isGoEndpoint, goSessionId, goClientHeaders } from "./llm-runner.js";

describe("isGoEndpoint host 作用域", () => {
  it("opencode.ai 命中（含路径变体），仿冒域/坏 URL 不命中", () => {
    expect(isGoEndpoint("https://opencode.ai/zen/go/v1")).toBe(true);
    expect(isGoEndpoint("https://opencode.ai/zen/go/v1/chat/completions")).toBe(true);
    expect(isGoEndpoint("https://ark.cn-beijing.volces.com/api/coding/v3")).toBe(false);
    expect(isGoEndpoint("https://api.deepseek.com/v1")).toBe(false);
    expect(isGoEndpoint("https://opencode.ai.evil.example/v1")).toBe(false);
    expect(isGoEndpoint("not-a-url")).toBe(false);
  });
});

describe("goClientHeaders", () => {
  it("Go 端点：UA 自标识 + 稳定 session id（跨调用稳定）", () => {
    const h = goClientHeaders("https://opencode.ai/zen/go/v1", "glm-5.3-flash");
    expect(h["User-Agent"]).toBe("tdb-memory/1.0");
    expect(h["x-opencode-session"]).toMatch(/^[0-9a-f]{32}$/);
    expect(goClientHeaders("https://opencode.ai/zen/go/v1", "glm-5.3-flash")).toEqual(h);
  });
  it("session id 随 model 变化（模型切换后缓存域隔离）", () => {
    const a = goClientHeaders("https://opencode.ai/zen/go/v1", "glm-5.3-flash");
    const b = goClientHeaders("https://opencode.ai/zen/go/v1", "glm-5.3");
    expect(a["x-opencode-session"]).not.toBe(b["x-opencode-session"]);
  });
  it("其他供应商：空对象（零额外头）", () => {
    expect(goClientHeaders("https://ark.cn-beijing.volces.com/api/coding/v3", "ark-code-latest")).toEqual({});
    expect(goClientHeaders("https://api.deepseek.com/v1", "deepseek-chat")).toEqual({});
  });
});
