/**
 * P1 召回质量 spec §4.3（task-1）：memory.recall.rerank.* 配置解析。
 * 铁律：enabled 缺省 false + provider 缺省 none = 零行为变化（config-first；
 * yaml 显式开启前，任何调用方都拿不到精排通道）。
 * 校验沿 embedding 先例（config.ts 同文件）：云端 provider 缺 apiKey →
 * configError + enabled 强制 false（不在启动路径抛异常）；非法 provider →
 * 回落 none + configError（保留原始值于错误文案供排查）。
 */
import { describe, expect, it } from "vitest";

import { parseConfig } from "../../config.js";

const rerankOf = (raw: Record<string, unknown>) => parseConfig(raw).recall.rerank;

describe("P1 task-1 config：memory.recall.rerank（缺省全关 = 零行为变化）", () => {
  it("零配置：enabled false + provider none + spec §4.3 全键缺省值", () => {
    const r = rerankOf({});
    expect(r.enabled).toBe(false);
    expect(r.provider).toBe("none");
    expect(r.apiKey).toBe("");
    expect(r.baseUrl).toBe("");
    expect(r.model).toBe("");
    expect(r.timeoutMs).toBe(800);
    expect(r.candidates).toBe(12);
    expect(r.minScore).toBe(-2.0);
    expect(r.local.modelDir).toBe("");
    expect(r.local.idleUnloadMs).toBe(600_000);
    expect(r.shadowMode).toBe(true);
    expect(r.configError).toBeUndefined();
  });

  it("显式开启（siliconflow + apiKey）：字段透传，无 configError", () => {
    const r = rerankOf({
      recall: {
        rerank: {
          enabled: true,
          provider: "siliconflow",
          apiKey: "sk-test",
          model: "Qwen/Qwen3-Reranker-8B",
          timeoutMs: 1500,
          candidates: 20,
          minScore: 0.1,
          shadowMode: false,
        },
      },
    });
    expect(r.enabled).toBe(true);
    expect(r.provider).toBe("siliconflow");
    expect(r.apiKey).toBe("sk-test");
    expect(r.model).toBe("Qwen/Qwen3-Reranker-8B");
    expect(r.timeoutMs).toBe(1500);
    expect(r.candidates).toBe(20);
    expect(r.minScore).toBe(0.1);
    expect(r.shadowMode).toBe(false);
    expect(r.configError).toBeUndefined();
  });

  it("apiKey/baseUrl/model 空串与纯空白按缺省处理（str() 既有语义）", () => {
    const r = rerankOf({ recall: { rerank: { apiKey: "   ", baseUrl: "", model: " " } } });
    expect(r.apiKey).toBe("");
    expect(r.baseUrl).toBe("");
    expect(r.model).toBe("");
  });
});

describe("P1 task-1 config：provider 校验（embedding 先例——configError 不抛异常）", () => {
  it("非法 provider（'openai'）：回落 none + enabled 强制 false + configError 含原始值", () => {
    const r = rerankOf({ recall: { rerank: { enabled: true, provider: "openai" } } });
    expect(r.enabled).toBe(false);
    expect(r.provider).toBe("none");
    expect(r.configError).toContain("openai");
  });

  it("siliconflow 缺 apiKey：enabled 强制 false，provider 保留供错误定位，configError 含 'apiKey'", () => {
    const r = rerankOf({ recall: { rerank: { enabled: true, provider: "siliconflow" } } });
    expect(r.enabled).toBe(false);
    expect(r.provider).toBe("siliconflow");
    expect(r.configError).toContain("apiKey");
  });

  it("dashscope 缺 apiKey：同 siliconflow", () => {
    const r = rerankOf({ recall: { rerank: { enabled: true, provider: "dashscope" } } });
    expect(r.enabled).toBe(false);
    expect(r.provider).toBe("dashscope");
    expect(r.configError).toContain("apiKey");
  });

  it("provider 'local' 是合法可插拔 id：接受且不报错（Task 3 落地前工厂返回 null）", () => {
    const r = rerankOf({ recall: { rerank: { enabled: true, provider: "local" } } });
    expect(r.enabled).toBe(true);
    expect(r.provider).toBe("local");
    expect(r.configError).toBeUndefined();
  });

  it("provider 'none' 显式设置：合法且关闭，无 configError", () => {
    const r = rerankOf({ recall: { rerank: { enabled: true, provider: "none" } } });
    expect(r.provider).toBe("none");
    expect(r.enabled).toBe(true);
    expect(r.configError).toBeUndefined();
  });
});

describe("P1 task-1 config：rerank 数值边界 clamp", () => {
  it("timeoutMs：负值 clamp 0（沿 v3Recall '语义自毁不拦 loud 显形' 先例）；非数值回落 800", () => {
    expect(rerankOf({ recall: { rerank: { timeoutMs: -5 } } }).timeoutMs).toBe(0);
    expect(rerankOf({ recall: { rerank: { timeoutMs: "800" as unknown as number } } }).timeoutMs).toBe(800);
    expect(rerankOf({ recall: { rerank: { timeoutMs: 2000 } } }).timeoutMs).toBe(2000);
  });

  it("candidates：clamp [1,100] 取整（0 抬到 1，9999 压到 100，小数向下取整）", () => {
    expect(rerankOf({ recall: { rerank: { candidates: 0 } } }).candidates).toBe(1);
    expect(rerankOf({ recall: { rerank: { candidates: 9999 } } }).candidates).toBe(100);
    expect(rerankOf({ recall: { rerank: { candidates: 12.7 } } }).candidates).toBe(12);
    expect(rerankOf({ recall: { rerank: { candidates: -3 } } }).candidates).toBe(1);
    expect(rerankOf({ recall: { rerank: { candidates: "x" as unknown as number } } }).candidates).toBe(12);
  });

  it("minScore：任意有限数透传（负值合法——local logits 刻度门槛可为负）；非数值回落 -2.0", () => {
    expect(rerankOf({ recall: { rerank: { minScore: -999 } } }).minScore).toBe(-999);
    expect(rerankOf({ recall: { rerank: { minScore: 0.5 } } }).minScore).toBe(0.5);
    expect(rerankOf({ recall: { rerank: { minScore: "x" as unknown as number } } }).minScore).toBe(-2.0);
  });

  it("local.idleUnloadMs：负值 clamp 0（0 = 常驻，spec §4.3）；缺省 600000", () => {
    expect(rerankOf({ recall: { rerank: { local: { idleUnloadMs: -1 } } } }).local.idleUnloadMs).toBe(0);
    expect(rerankOf({ recall: { rerank: { local: { idleUnloadMs: 0 } } } }).local.idleUnloadMs).toBe(0);
    expect(rerankOf({ recall: { rerank: { local: { modelDir: "D:/models/reranker" } } } }).local.modelDir).toBe(
      "D:/models/reranker",
    );
  });

  it("shadowMode：缺省 true（phase-1 只记录不生效）；显式 false 透传", () => {
    expect(rerankOf({}).shadowMode).toBe(true);
    expect(rerankOf({ recall: { rerank: { shadowMode: false } } }).shadowMode).toBe(false);
  });
});
