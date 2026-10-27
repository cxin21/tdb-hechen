import { describe, it, expect } from "vitest";
import { embeddingKeyFor, writeFactsOf, supersessionEnabled, DEFAULT_WRITE_POLICY } from "./write-policy.js";
import type { WritePolicy } from "./write-policy.js";

/**
 * #134 生产写面（W1/W2）契约：
 *  - 缺省（全关）→ embedding 键逐位返回内容（零行为变化）
 *  - W1 开 + 有 subject → 内容 + 分隔符 + 事实短语
 *  - W2 开 → update/merge 旧行走「标记失效」（调用方据此改 invalidate），缺省走归档
 */
describe("write-policy", () => {
  const on: WritePolicy = {
    factKey: { enabled: true, separator: " | ", maxFactChars: 240 },
    supersession: { enabled: true },
  };
  const memory = { metadata: { subject: "Instagram 粉丝数" } } as never;

  it("缺省策略：键=原文、supersession 关", () => {
    expect(embeddingKeyFor("我的粉丝涨到 1300 了", memory)).toBe("我的粉丝涨到 1300 了");
    expect(embeddingKeyFor("我的粉丝涨到 1300 了", memory, DEFAULT_WRITE_POLICY)).toBe("我的粉丝涨到 1300 了");
    expect(supersessionEnabled()).toBe(false);
    expect(supersessionEnabled(DEFAULT_WRITE_POLICY)).toBe(false);
  });

  it("W1 开：键=原文 + 分隔符 + subject；无 subject 时逐位原文", () => {
    expect(embeddingKeyFor("我的粉丝涨到 1300 了", memory, on)).toBe("我的粉丝涨到 1300 了 | Instagram 粉丝数");
    expect(embeddingKeyFor("我的粉丝涨到 1300 了", { metadata: {} } as never, on)).toBe("我的粉丝涨到 1300 了");
  });

  it("事实来源只取 metadata.subject（零额外 LLM 成本）；空串忽略", () => {
    expect(writeFactsOf(memory)).toEqual(["Instagram 粉丝数"]);
    expect(writeFactsOf({ metadata: { subject: "   " } } as never)).toEqual([]);
    expect(writeFactsOf(undefined)).toEqual([]);
  });

  it("W2 开：supersession 生效", () => {
    expect(supersessionEnabled(on)).toBe(true);
  });
});
