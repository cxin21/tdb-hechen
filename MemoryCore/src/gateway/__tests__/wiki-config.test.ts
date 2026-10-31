/**
 * task-73 · wiki 薄转发配置解析（resolveWikiForwardConfig）行为契约。
 *
 * 为什么单独测：配置解析是「yaml/env -> 运行时」的唯一入口，历史上 sceneGovernance 就是
 * 挂错层级 + 解析器从不读取，导致机制在位却零执行。这里的断言只盯三件事：
 *   1. 缺省值就是文档承诺的那份（改缺省必须改本测试）；
 *   2. env 覆盖优先于入参，非法值回落缺省且**永不抛**（启动路径不许被配置打挂）；
 *   3. clamp 生效（perWikiLimit/topK/concurrency 越界不放大成上游风暴）。
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_WIKI_FORWARD_CONFIG, resolveWikiForwardConfig } from "../wiki-config.js";

describe("resolveWikiForwardConfig", () => {
  it("空入参 = 文档承诺的缺省值", () => {
    expect(resolveWikiForwardConfig()).toEqual(DEFAULT_WIKI_FORWARD_CONFIG);
    expect(DEFAULT_WIKI_FORWARD_CONFIG.enabled).toBe(true);
    expect(DEFAULT_WIKI_FORWARD_CONFIG.teamVerify).toBe("enforce");
    expect(DEFAULT_WIKI_FORWARD_CONFIG.baseUrl).toBe("http://127.0.0.1:8421");
  });

  it("yaml 值原样生效（不做隐式改名）", () => {
    const cfg = resolveWikiForwardConfig(
      { enabled: false, baseUrl: "http://10.0.0.9:8421", teamVerify: "warn", topK: 3, perWikiLimit: 2 },
      {},
    );
    expect(cfg).toMatchObject({ enabled: false, baseUrl: "http://10.0.0.9:8421", teamVerify: "warn", topK: 3, perWikiLimit: 2 });
  });

  it("env 覆盖 yaml，且大写布尔/非法数字都不抛", () => {
    const cfg = resolveWikiForwardConfig(
      { enabled: true, topK: 6 },
      { TDB_WIKI_ENABLED: "false", TDB_WIKI_TOP_K: "not-a-number", TDB_WIKI_TEAM_VERIFY: "bogus" },
    );
    expect(cfg.enabled).toBe(false);
    // 非法数字回落 yaml/缺省
    expect(cfg.topK).toBe(6);
    // 非法档位回落缺省 enforce（宁严不松）
    expect(cfg.teamVerify).toBe("enforce");
  });

  it("越界值被 clamp（不放大上游压力）", () => {
    const cfg = resolveWikiForwardConfig({ perWikiLimit: 999, topK: 999, maxWikis: 999, concurrency: 999, minScore: -5 }, {});
    expect(cfg.perWikiLimit).toBeLessThanOrEqual(20);
    expect(cfg.topK).toBeLessThanOrEqual(50);
    expect(cfg.maxWikis).toBeLessThanOrEqual(16);
    expect(cfg.concurrency).toBeLessThanOrEqual(16);
    expect(cfg.minScore).toBeGreaterThanOrEqual(0);
  });
});
