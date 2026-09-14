/**
 * V2-2 引擎一 · 查询自动扩展（DS-RECALL-V2-THREE-ENGINES-001 §E1.1-E1.4）RED 套件。
 *
 * 覆盖（brief RED 清单）：解析防御（非串丢弃/去重/去原词）+ LLM 失败退化（[]）+
 * TTL 缓存 + mergeFtsQueryWithExpansion（FTS OR 合并纯函数）+ maxTokens 8192 覆写。
 */
import { describe, expect, it } from "vitest";
import {
  buildExpansionPrompt,
  mergeFtsQueryWithExpansion,
  parseExpansion,
  expandQuery,
  QUERY_EXPANSION_DEFAULTS,
  QUERY_EXPANSION_MAX_TOKENS_OVERRIDE,
  type ExpansionRunner,
} from "../../recall/query-expand.js";

function mockRunner(reply: () => string | Promise<string>): ExpansionRunner & {
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    run: async (p: Record<string, unknown>) => {
      calls.push(p);
      return reply();
    },
  } as unknown as ExpansionRunner & { calls: Array<Record<string, unknown>> };
}

describe("V2-2 E1.2 buildExpansionPrompt", () => {
  it("含 query 原文 + 纯语义扩展指令（零语料泄漏）+ JSON 数组格式要求", () => {
    const p = buildExpansionPrompt("怎么提高召回的全面性");
    expect(p).toContain("怎么提高召回的全面性");
    expect(p).toContain("JSON");
    expect(p).toContain("5-8");
  });
});

describe("V2-2 E1.2 parseExpansion 解析防御", () => {
  it("JSON 字符串数组 → 逐项返回", () => {
    expect(parseExpansion('["召回率","覆盖率"]')).toEqual(["召回率", "覆盖率"]);
  });

  it("非法 JSON / 非数组 → []（解析失败退化）", () => {
    expect(parseExpansion("not json")).toEqual([]);
    expect(parseExpansion('{"terms":["a"]}')).toEqual([]);
    expect(parseExpansion("")).toEqual([]);
  });

  it("非字符串项丢弃（宁缺毋滥）", () => {
    expect(parseExpansion('[1,"a",null,"b",{"x":1},true]')).toEqual(["a", "b"]);
  });

  it("trim + 空串丢弃 + 去重（大小写不敏感）", () => {
    expect(parseExpansion('[" a ","a","A","b"," "]')).toEqual(["a", "b"]);
  });

  it("去除与原 query 相同项（大小写不敏感）", () => {
    expect(parseExpansion('["覆盖率","TS 编程","ts 编程"]', { original: "TS 编程" })).toEqual([
      "覆盖率",
    ]);
  });

  it("maxTerms 上限截断（默认 8）", () => {
    const raw = JSON.stringify(["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9", "t10"]);
    expect(parseExpansion(raw)).toHaveLength(8);
    expect(parseExpansion(raw, { maxTerms: 3 })).toEqual(["t1", "t2", "t3"]);
  });
});

describe("V2-2 E1.2 expandQuery（standalone runner + 失败退化 + TTL 缓存）", () => {
  it("成功：解析词表返回；run 收到 taskId / maxTokens=8192 / timeoutMs", async () => {
    const runner = mockRunner(() => '["召回率","覆盖率"]');
    const terms = await expandQuery("全面性", runner, { ttlMs: 0, timeoutMs: 8000 });
    expect(terms).toEqual(["召回率", "覆盖率"]);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.maxTokens).toBe(QUERY_EXPANSION_MAX_TOKENS_OVERRIDE);
    expect(QUERY_EXPANSION_MAX_TOKENS_OVERRIDE).toBe(8192);
    expect(String(runner.calls[0]!.taskId)).toContain("query");
    expect(runner.calls[0]!.timeoutMs).toBe(8000);
  });

  it("LLM 抛错 → []（失败退化，不向调用方传播）", async () => {
    const runner = mockRunner(() => {
      throw new Error("upstream down");
    });
    await expect(expandQuery("q-fail-a", runner, { ttlMs: 0 })).resolves.toEqual([]);
  });

  it("回复非 JSON / 非数组 → []（解析失败退化）", async () => {
    expect(await expandQuery("q-bad-1", mockRunner(() => "抱歉我无法回答"), { ttlMs: 0 })).toEqual([]);
    expect(await expandQuery("q-bad-2", mockRunner(() => '{"a":1}'), { ttlMs: 0 })).toEqual([]);
  });

  it("空 query / 空 runner → []", async () => {
    await expect(expandQuery("  ", mockRunner(() => '["a"]'), { ttlMs: 0 })).resolves.toEqual([]);
    await expect(expandQuery("q-no-runner", undefined as unknown as ExpansionRunner, { ttlMs: 0 })).resolves.toEqual([]);
  });

  it("TTL 缓存：TTL 内同 query 复用（runner 只调一次）；ttl=0 不缓存", async () => {
    const cached = mockRunner(() => '["t1"]');
    await expandQuery("q-ttl-cache-on", cached, { ttlMs: 60_000 });
    await expandQuery("q-ttl-cache-on", cached, { ttlMs: 60_000 });
    expect(cached.calls).toHaveLength(1);

    const uncached = mockRunner(() => '["t1"]');
    await expandQuery("q-ttl-off", uncached, { ttlMs: 0 });
    await expandQuery("q-ttl-off", uncached, { ttlMs: 0 });
    expect(uncached.calls).toHaveLength(2);
  });

  it("默认值锚：ttl 600_000 / timeout 8000 / maxTerms 8（E1.1）", () => {
    expect(QUERY_EXPANSION_DEFAULTS).toEqual({ enabled: true, maxTerms: 8, ttlMs: 600_000, timeoutMs: 8000 });
  });
});

describe("V2-2 E1.3 mergeFtsQueryWithExpansion（FTS OR 合并纯函数）", () => {
  it("原词在前、扩展词 OR 追加（词面足迹 widening）", () => {
    expect(mergeFtsQueryWithExpansion('"全面性" OR "召回"', ["覆盖率", "红牌"])).toBe(
      '"全面性" OR "召回" OR "覆盖率" OR "红牌"',
    );
  });

  it("与既有 token 重复的扩展词不再追加（大小写不敏感）", () => {
    expect(mergeFtsQueryWithExpansion('"覆盖率"', ["覆盖率", "TS"])).toBe('"覆盖率" OR "TS"');
  });

  it("ftsQuery=null 且无扩展词 → null；仅有扩展词 → 纯扩展 MATCH", () => {
    expect(mergeFtsQueryWithExpansion(null, [])).toBeNull();
    expect(mergeFtsQueryWithExpansion(null)).toBeNull();
    expect(mergeFtsQueryWithExpansion(null, ["覆盖率"])).toBe('"覆盖率"');
  });

  it("扩展词防御：空串/引号剥离/去重", () => {
    expect(mergeFtsQueryWithExpansion('"a"', ["", ' "b" ', "b", '"c"'])).toBe('"a" OR "b" OR "c"');
  });
});
