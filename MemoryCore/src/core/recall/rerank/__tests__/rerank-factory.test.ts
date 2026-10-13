/**
 * P1 召回质量 spec §4.3（task-1）：rerank provider 工厂路由测试。
 * 路由合同：enabled=false / provider=none / 未配置 → null（=skip，调用方
 * 降级现状）；siliconflow/dashscope → 对应 adapter 实例；local → null
 * （可插拔 provider id：Task 3 落地前的显式占位，config 合法接受，
 * 工厂集中标注——接线时只改 factory 一处）。
 */
import { describe, expect, it, vi } from "vitest";

import { parseConfig } from "../../../../config.js";
import { createReranker } from "../factory.js";
import { DashscopeReranker } from "../dashscope.js";
import { SiliconflowReranker } from "../siliconflow.js";

const rerankConfigOf = (raw: Record<string, unknown>) => parseConfig({ recall: { rerank: raw } }).recall.rerank;

describe("P1 task-1 rerank 工厂：路由", () => {
  it("缺省（未配置）→ null：零行为变化的第一道闸", () => {
    expect(createReranker(rerankConfigOf({}))).toBeNull();
  });

  it("enabled:false（无论 provider）→ null", () => {
    expect(createReranker(rerankConfigOf({ enabled: false, provider: "siliconflow", apiKey: "sk" }))).toBeNull();
  });

  it("enabled:true + provider:none → null（显式 none = skip）", () => {
    expect(createReranker(rerankConfigOf({ enabled: true, provider: "none" }))).toBeNull();
  });

  it("enabled:true + siliconflow + apiKey → SiliconflowReranker 实例", () => {
    const rr = createReranker(rerankConfigOf({ enabled: true, provider: "siliconflow", apiKey: "sk-x" }));
    expect(rr).toBeInstanceOf(SiliconflowReranker);
    expect(typeof rr?.rerank).toBe("function");
  });

  it("enabled:true + dashscope + apiKey → DashscopeReranker 实例", () => {
    const rr = createReranker(rerankConfigOf({ enabled: true, provider: "dashscope", apiKey: "sk-y" }));
    expect(rr).toBeInstanceOf(DashscopeReranker);
    expect(typeof rr?.rerank).toBe("function");
  });

  it("provider:'local' → null（Task 3 可插拔占位；config 合法接受、工厂显式关断）", () => {
    expect(createReranker(rerankConfigOf({ enabled: true, provider: "local" }))).toBeNull();
  });

  it("云端 provider 缺 apiKey（config 已强制 enabled=false + configError）→ null 双保险", () => {
    const cfg = rerankConfigOf({ enabled: true, provider: "siliconflow" });
    expect(cfg.enabled).toBe(false);
    expect(cfg.configError).toBeTruthy();
    expect(createReranker(cfg)).toBeNull();
  });

  it("apiKey 为纯空白视同缺省：siliconflow 路由为 null（校验同源）", () => {
    expect(createReranker(rerankConfigOf({ enabled: true, provider: "siliconflow", apiKey: "   " }))).toBeNull();
  });
});

describe("P1 task-1 rerank 工厂：依赖注入透传", () => {
  it("opts.fetchImpl 透传到 adapter（自定义 fetch 被实际调用）", async () => {
    const fetchMock = vi.fn(async () => new Response("no", { status: 429 }));
    const rr = createReranker(rerankConfigOf({ enabled: true, provider: "siliconflow", apiKey: "sk-z" }), {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(rr).toBeInstanceOf(SiliconflowReranker);
    expect(await rr!.rerank("q", ["d"])).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
