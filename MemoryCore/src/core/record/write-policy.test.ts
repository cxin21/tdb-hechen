import { describe, it, expect } from "vitest";
import {
  DEFAULT_WRITE_POLICY,
  embeddingKeyFor,
  factChannelKeyFor,
  supersessionEnabled,
  writeFactSetOf,
  writeFactsOf,
} from "./write-policy.js";
import type { WritePolicy } from "./write-policy.js";

/**
 * #134/#137 生产写面（W1 事实键 / W1-C 事实通道 / W2）契约：
 *  - 缺省（全关）→ embedding 键逐位返回内容（零行为变化）
 *  - replace 档：键 = 原文 + 分隔符 + **多条**事实（#137 从单 subject 扩到 facts[]）
 *  - channel 档（#137）：原文主索引**逐位不动**，事实走 factChannelKeyFor 的独立通道键
 *  - W2 开 → update/merge 旧行走「标记失效」
 */
describe("write-policy", () => {
  const replaceOn: WritePolicy = {
    factKey: { enabled: true, mode: "replace", separator: " | ", maxFactChars: 240 },
    supersession: { enabled: true },
  };
  const channelOn: WritePolicy = {
    factKey: { enabled: true, mode: "channel", separator: " | ", maxFactChars: 240, maxFacts: 5 },
    supersession: { enabled: false },
  };
  const memory = { metadata: { subject: "Instagram 粉丝数" } } as never;
  const multiFactMemory = {
    metadata: { facts: ["用户养了一只叫团子的猫", "用户住在杭州", "用户养了一只叫团子的猫"] },
  } as never;

  it("缺省策略：键=原文、supersession 关", () => {
    expect(embeddingKeyFor("我的粉丝涨到 1300 了", memory)).toBe("我的粉丝涨到 1300 了");
    expect(embeddingKeyFor("我的粉丝涨到 1300 了", memory, DEFAULT_WRITE_POLICY)).toBe("我的粉丝涨到 1300 了");
    expect(supersessionEnabled()).toBe(false);
    expect(supersessionEnabled(DEFAULT_WRITE_POLICY)).toBe(false);
    expect(factChannelKeyFor({ type: "work_fact" }, multiFactMemory, DEFAULT_WRITE_POLICY)).toBe("");
  });

  it("replace 档：键=原文 + 多条事实（去重后拼接）；无事实时逐位原文", () => {
    expect(embeddingKeyFor("我的粉丝涨到 1300 了", memory, replaceOn)).toBe("我的粉丝涨到 1300 了 | Instagram 粉丝数");
    expect(embeddingKeyFor("原文", { metadata: {} } as never, replaceOn)).toBe("原文");
    expect(embeddingKeyFor("原文", multiFactMemory, replaceOn)).toBe(
      "原文 | 用户养了一只叫团子的猫 | 用户住在杭州",
    );
  });

  it("事实来源：metadata.facts 优先，metadata.subject 作为回退并参与去重", () => {
    expect(writeFactsOf(memory)).toEqual(["Instagram 粉丝数"]);
    expect(writeFactsOf({ metadata: { subject: "   " } } as never)).toEqual([]);
    expect(writeFactsOf(undefined)).toEqual([]);
    expect(writeFactsOf(multiFactMemory)).toEqual(["用户养了一只叫团子的猫", "用户住在杭州"]);
    expect(
      writeFactsOf({ metadata: { facts: ["用户住在杭州"], subject: "用户住在杭州" } } as never),
    ).toEqual(["用户住在杭州"]);
  });

  it("三元组：metadata.factTriples 只进 triples；includeTriples 时才展开成短语进键", () => {
    const m = { metadata: { factTriples: [{ subject: "用户", predicate: "住在", value: "杭州" }] } } as never;
    expect(writeFactSetOf(m)).toEqual({
      phrases: [],
      triples: [{ subject: "用户", predicate: "住在", value: "杭州" }],
    });
    expect(writeFactsOf(m)).toEqual([]);
    const withTriples: WritePolicy = {
      factKey: { ...channelOn.factKey, includeTriples: true },
      supersession: { enabled: false },
    };
    expect(factChannelKeyFor({ type: "episodic" }, m, withTriples)).toBe("用户 住在 杭州");
  });

  it("channel 档：原文主索引逐位不动；事实通道键只含事实", () => {
    expect(embeddingKeyFor("原文", multiFactMemory, channelOn)).toBe("原文");
    expect(factChannelKeyFor({ type: "episodic" }, multiFactMemory, channelOn)).toBe(
      "用户养了一只叫团子的猫 | 用户住在杭州",
    );
    expect(factChannelKeyFor({ type: "episodic" }, { metadata: {} } as never, channelOn)).toBe("");
  });

  it("channel 档 onlyForTypes：类型不在名单 → 通道退出（原文仍不受影响）", () => {
    const onlyWorkFact: WritePolicy = {
      factKey: { ...channelOn.factKey, onlyForTypes: ["work_fact"] },
      supersession: { enabled: false },
    };
    expect(factChannelKeyFor({ type: "work_fact" }, multiFactMemory, onlyWorkFact)).not.toBe("");
    expect(factChannelKeyFor({ type: "episodic" }, multiFactMemory, onlyWorkFact)).toBe("");
  });

  it("channel 档 maxFacts / maxFactChars 预算生效（噪声与超预算事实不进键）", () => {
    const capped: WritePolicy = {
      factKey: { ...channelOn.factKey, maxFacts: 1, maxFactChars: 12 },
      supersession: { enabled: false },
    };
    expect(factChannelKeyFor({ type: "episodic" }, multiFactMemory, capped)).toBe("用户养了一只叫团子的猫");
  });

  it("W2 开：supersession 生效", () => {
    expect(supersessionEnabled(replaceOn)).toBe(true);
  });
});
