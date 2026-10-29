/**
 * #68（core 启动暖机化 / boot warmup）单测 —— 非致命合同 + /health warmup 段形状。
 *
 * 覆盖（设计文档 docs/research/2026-10-19-r5-boot-warmup-design.md 测试清单）：
 *   - warmup 幂等：runPreListen / runPostListen 各只执行一次（重复调用 no-op）
 *   - 逐步失败注入：任一步抛错 → warn + status=failed，服务照常（后续步骤仍执行、
 *     不抛出、终态 done 不覆盖 failed）
 *   - S0 在 listen 前执行：runPreListen 同步返回即完成（server.ts 源级次序合同另测）
 *   - jieba 预载后 buildFtsQuery 无二次加载（真实 sqlite 单例 + 哨兵实例证明）
 *   - S1 TdaiCore.waitForStores 有界等待（就绪 true / 超时 false / gate 拒绝 false）
 *   - /health warmup 段形状（HealthWarmupInfo：status/steps/totalMs）
 *
 * LLM 永不进单测：S2/S3 均为注入的假步骤（生产实现见 server.ts getBootWarmup()）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BootWarmup,
  DEFAULT_STORE_READY_TIMEOUT_MS,
  RERANK_WARMUP_CLOUD_DOCS,
  buildRerankWarmupDocs,
  type BootWarmupDeps,
} from "../boot-warmup.js";
import { TdaiCore } from "../../core/tdai-core.js";
import type { HostAdapter, Logger } from "../../core/types.js";
import type { MemoryTdaiConfig } from "../../config.js";
import {
  _isJiebaLoadedForTest,
  _resetJiebaForTest,
  _setJiebaForTest,
  buildFtsQuery,
  tokenizeForFts,
} from "../../core/store/sqlite.js";

// ============================ helpers ============================

function fakeLogger(): { logger: Logger; infos: string[]; warns: string[] } {
  const infos: string[] = [];
  const warns: string[] = [];
  const logger: Logger = {
    info: (message: string) => {
      infos.push(message);
    },
    warn: (message: string) => {
      warns.push(message);
    },
    error: (message: string) => {
      infos.push("ERROR:" + message);
    },
  };
  return { logger, infos, warns };
}

interface StepCalls {
  jieba: number;
  store: number;
  qe: number;
  rerank: number;
}

function makeDeps(
  overrides?: Partial<BootWarmupDeps>,
): { deps: BootWarmupDeps; infos: string[]; warns: string[]; calls: StepCalls } {
  const log = fakeLogger();
  const calls: StepCalls = { jieba: 0, store: 0, qe: 0, rerank: 0 };
  // 计数包装：override（含抛错桩）也计入调用次数——失败注入后各步仍被尝试执行。
  const o = overrides ?? {};
  const deps: BootWarmupDeps = {
    logger: log.logger,
    jiebaPreload: () => {
      calls.jieba++;
      o.jiebaPreload?.();
    },
    waitForStores: async (timeoutMs) => {
      calls.store++;
      return (await o.waitForStores?.(timeoutMs)) ?? true;
    },
    queryExpandWarmup: async () => {
      calls.qe++;
      await o.queryExpandWarmup?.();
    },
    rerankWarmup: async () => {
      calls.rerank++;
      await o.rerankWarmup?.();
    },
  };
  return { deps, infos: log.infos, warns: log.warns, calls };
}

/** fire-and-forget 链落定（无 vi.waitFor；纯 resolved promise 链，几个宏任务必结算）。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// ============================ BootWarmup 非致命合同 ============================

describe("BootWarmup 非致命合同（#68）", () => {
  it("S0 在 listen 前同步执行：runPreListen() 返回即完成 jieba 步并已计时", () => {
    const { deps, calls } = makeDeps();
    const w = new BootWarmup(deps);
    w.runPreListen();
    // 同步合同：返回时 jieba 已执行、已计时，post-listen 步骤尚未开始
    expect(calls.jieba).toBe(1);
    expect(w.snapshot().status).toBe("warming");
    expect(typeof w.snapshot().steps.jiebaMs).toBe("number");
    expect(w.snapshot().steps.storeReadyMs).toBeUndefined();
    expect(calls.store).toBe(0);
  });

  it("幂等：runPreListen / runPostListen 重复调用各只执行一次", async () => {
    const { deps, calls, infos } = makeDeps();
    const w = new BootWarmup(deps);
    w.runPreListen();
    w.runPreListen();
    w.runPreListen();
    expect(calls.jieba).toBe(1);
    w.runPostListen();
    w.runPostListen();
    w.runPostListen();
    await flush();
    expect(calls).toEqual({ jieba: 1, store: 1, qe: 1, rerank: 1 });
    expect(infos.filter((m) => m.startsWith("[warmup] boot warmup total=")).length).toBe(1);
  });


  it("全成功 → status=done，四步耗时齐全，日志行符合设计（含 total 行 status=done）", async () => {
    const { deps, calls, infos } = makeDeps();
    const w = new BootWarmup(deps);
    w.runPreListen();
    w.runPostListen();
    await flush();
    expect(calls).toEqual({ jieba: 1, store: 1, qe: 1, rerank: 1 });
    expect(infos.some((m) => /^\[warmup\] jieba done in \d+ms$/.test(m))).toBe(true);
    expect(infos.some((m) => /^\[warmup\] store ready in \d+ms$/.test(m))).toBe(true);
    expect(infos.some((m) => /^\[warmup\] query-expand done in \d+ms$/.test(m))).toBe(true);
    expect(infos.some((m) => /^\[warmup\] boot warmup total=\d+ms \(status=done\)$/.test(m))).toBe(true);
  });

  it("S1 超时（false）非失败：warn 后继续 S2/S3，终态 done", async () => {
    const { deps, calls, warns } = makeDeps({ waitForStores: async () => false });
    const w = new BootWarmup(deps);
    w.runPreListen();
    w.runPostListen();
    await flush();
    expect(calls.qe).toBe(1);
    expect(calls.rerank).toBe(1);
    expect(w.snapshot().status).toBe("done");
    expect(warns.some((m) => /^\[warmup\] store not ready after \d+ms/.test(m))).toBe(true);
  });

  it("S1 抛错 → status=failed，S2/S3 仍执行（逐步失败注入）", async () => {
    const { deps, calls, warns } = makeDeps({
      waitForStores: async () => {
        throw new Error("boom-store");
      },
    });
    const w = new BootWarmup(deps);
    w.runPreListen();
    w.runPostListen(); // 永不 throw（fire-and-forget 双保险）
    await flush();
    expect(calls.qe).toBe(1);
    expect(calls.rerank).toBe(1);
    expect(w.snapshot().status).toBe("failed");
    expect(warns).toContain("[warmup] storeReady step failed (non-fatal): boom-store");
  });

  it("S2 抛错 → S3 仍执行，终态 failed", async () => {
    const { deps, calls, warns } = makeDeps({
      queryExpandWarmup: async () => {
        throw new Error("boom-qe");
      },
    });
    const w = new BootWarmup(deps);
    w.runPreListen();
    w.runPostListen();
    await flush();
    expect(calls.rerank).toBe(1);
    expect(w.snapshot().status).toBe("failed");
    expect(warns).toContain("[warmup] queryExpand step failed (non-fatal): boom-qe");
    expect(typeof w.snapshot().steps.rerankMs).toBe("number");
  });

  it("S3 抛错 → 终态 failed，total 行 status=failed，runPostListen 不抛出", async () => {
    const { deps, infos, warns } = makeDeps({
      rerankWarmup: async () => {
        throw new Error("boom-rerank");
      },
    });
    const w = new BootWarmup(deps);
    w.runPreListen();
    w.runPostListen();
    await flush();
    expect(w.snapshot().status).toBe("failed");
    expect(warns).toContain("[warmup] rerank step failed (non-fatal): boom-rerank");
    expect(infos.some((m) => /^\[warmup\] boot warmup total=\d+ms \(status=failed\)$/.test(m))).toBe(true);
  });

  it("S0 抛错 → status=failed 不阻断；后续步骤全成功也不覆盖 failed", async () => {
    const { deps, calls, warns } = makeDeps({
      jiebaPreload: () => {
        throw new Error("boom-jieba");
      },
    });
    const w = new BootWarmup(deps);
    expect(() => w.runPreListen()).not.toThrow();
    expect(w.snapshot().status).toBe("failed");
    expect(warns).toContain("[warmup] jieba step failed (non-fatal): boom-jieba");
    w.runPostListen();
    await flush();
    expect(calls).toEqual({ jieba: 1, store: 1, qe: 1, rerank: 1 });
    // done 不覆盖 failed（S0 失败必须反映在 /health warmup 段）
    expect(w.snapshot().status).toBe("failed");
  });

  it("snapshot() 防御性拷贝（/health 改不动内部状态）", async () => {
    const { deps } = makeDeps();
    const w = new BootWarmup(deps);
    w.runPreListen();
    const a = w.snapshot();
    a.steps.jiebaMs = -1;
    expect(w.snapshot()).not.toBe(a);
    expect(w.snapshot().steps).not.toBe(a.steps);
    expect(w.snapshot().steps.jiebaMs).toBeGreaterThanOrEqual(0);
  });

  it("/health warmup 段形状：HealthWarmupInfo 键集与类型（只加字段不改旧字段）", async () => {
    const { deps } = makeDeps();
    const w = new BootWarmup(deps);
    // listen 前：status=warming，仅 jieba 步
    w.runPreListen();
    const pre = w.snapshot();
    expect(Object.keys(pre).sort()).toEqual(["status", "steps", "totalMs"]);
    expect(pre.status).toBe("warming");
    expect(Object.keys(pre.steps)).toEqual(["jiebaMs"]);
    // listen 后：全键 + done
    w.runPostListen();
    await flush();
    const post = w.snapshot();
    expect(Object.keys(post).sort()).toEqual(["status", "steps", "totalMs"]);
    expect(post.status).toBe("done");
    expect(new Set(Object.keys(post.steps))).toEqual(
      new Set(["jiebaMs", "storeReadyMs", "queryExpandMs", "rerankMs"]),
    );
    for (const v of Object.values(post.steps)) expect(typeof v).toBe("number");
    expect(typeof post.totalMs).toBe("number");
    expect(post.totalMs).toBeGreaterThanOrEqual(0);
  });
});


// ============================ S1：TdaiCore.waitForStores 有界等待 ============================

describe("S1 TdaiCore.waitForStores 有界等待（#68）", () => {
  function makeCore(storeReady?: Promise<void>): TdaiCore {
    const logger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
    const host = {
      hostType: "standalone",
      getRuntimeContext: () => ({ dataDir: "unused" }),
      getLogger: () => logger,
      getLLMRunnerFactory: () => () => {
        throw new Error("not used in warmup test");
      },
    } as unknown as HostAdapter;
    // 构造器只读 hostAdapter 三方法与可选参数，不触盘（不调 initialize()）。
    const core = new TdaiCore({
      hostAdapter: host,
      config: {} as unknown as MemoryTdaiConfig,
      instanceId: "boot-warmup-test",
    });
    if (storeReady !== undefined) Object.assign(core, { storeReady });
    return core;
  }

  it("storeReady 缺省（未初始化/已销毁）→ 立即 true，不等待", async () => {
    const core = makeCore();
    expect(await core.waitForStores(5_000)).toBe(true);
  });

  it("就绪 gate → true", async () => {
    const core = makeCore(Promise.resolve());
    expect(await core.waitForStores(5_000)).toBe(true);
  });

  it("超时 → false（有界、不 reject）", async () => {
    const core = makeCore(new Promise<void>(() => undefined)); // 永不就绪
    const t0 = Date.now();
    expect(await core.waitForStores(30)).toBe(false);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(20);
    expect(elapsed).toBeLessThan(2_000); // 有界性 sanity：远小于 5s 合同上限
  });

  it("gate reject → false 非 throw（initStores 自吞错之外的兜底）", async () => {
    const core = makeCore(Promise.reject(new Error("store boom")));
    expect(await core.waitForStores(5_000)).toBe(false);
  });
});

// ============================ S0：jieba 预载（真实 sqlite 单例合同） ============================

describe("S0 jieba 预载合同（真实 sqlite 单例）", () => {
  beforeEach(() => {
    _resetJiebaForTest();
  });
  afterEach(() => {
    _resetJiebaForTest();
  });

  it("listen 侧预载后单例已加载；buildFtsQuery 走缓存单例不二次加载（哨兵证明）", () => {
    // 生产 S0 依赖的形态：listen 前同步调一次索引侧 tokenizeForFts 预载字典
    const { deps } = makeDeps({
      jiebaPreload: () => {
        tokenizeForFts("[warmup] FTS 字典预加载");
      },
    });
    const w = new BootWarmup(deps);
    w.runPreListen();
    // 真实 jieba（@node-rs/jieba）已在 vitest 环境可用并完成加载
    expect(_isJiebaLoadedForTest()).toBe(true);
    expect(typeof w.snapshot().steps.jiebaMs).toBe("number");

    // 哨兵替换缓存单例：若后续查询侧重新加载（而非复用缓存），输出不会含哨兵 token
    type JiebaLike = NonNullable<Parameters<typeof _setJiebaForTest>[0]>;
    const sentinel = {
      cutForSearch: (_raw: string) => ["SENTINEL_TOKEN"],
    } as unknown as JiebaLike;
    _setJiebaForTest(sentinel);
    const q = buildFtsQuery("人工智能");
    expect(q).toContain("SENTINEL_TOKEN"); // 命中缓存单例 = 无二次加载
  });

  it("jieba 不可用（null）→ 预载不失败，tokenizeForFts 回退原文", () => {
    _setJiebaForTest(null);
    expect(_isJiebaLoadedForTest()).toBe(false);
    expect(tokenizeForFts("用户五月去日本旅行")).toBe("用户五月去日本旅行");
  });
});


// ============================ S3：预热档位与常量 ============================

describe("S3 rerank 预热档位（#68 档位升级）", () => {
  it("buildRerankWarmupDocs：缺省 32 条（= rerank 生产缺省）、每条 50-200 字真实长度样本", () => {
    const docs = buildRerankWarmupDocs();
    expect(docs.length).toBe(32);
    for (const d of docs) {
      expect(d.length).toBeGreaterThanOrEqual(50);
      expect(d.length).toBeLessThanOrEqual(200);
    }
  });

  it("candidates 档位 clamp [1,100]（config 解析同口径），非法输入回退 32", () => {
    expect(buildRerankWarmupDocs(undefined).length).toBe(32);
    expect(buildRerankWarmupDocs(0).length).toBe(1);
    expect(buildRerankWarmupDocs(1).length).toBe(1);
    expect(buildRerankWarmupDocs(5).length).toBe(5);
    expect(buildRerankWarmupDocs(500).length).toBe(100);
    expect(buildRerankWarmupDocs(Number.NaN).length).toBe(32);
    expect(buildRerankWarmupDocs(Number.POSITIVE_INFINITY).length).toBe(32);
  });

  it("cloud dummy：1 query × 1 doc（云端预热目标=首连/鉴权/往返）", () => {
    expect(RERANK_WARMUP_CLOUD_DOCS.length).toBe(1);
    expect(typeof RERANK_WARMUP_CLOUD_DOCS[0]).toBe("string");
  });

  it("S1 等待上限缺省 5000ms（设计合同 ≤5s）", () => {
    expect(DEFAULT_STORE_READY_TIMEOUT_MS).toBe(5_000);
  });
});

// ============================ server.ts 挂接次序（源级合同） ============================

describe("server.ts S0/S1-S3 挂接次序（源级合同）", () => {
  const src = readFileSync(fileURLToPath(new URL("../server.ts", import.meta.url)), "utf8");

  it("runPreListen 在 listen 之前、runPostListen 在 listen 之后，且旧 startRerankWarmup 已移除", () => {
    const s0 = src.indexOf("this.getBootWarmup().runPreListen();");
    const portLine = src.indexOf("const { port, host } = this.config.server;");
    const post = src.indexOf("this.getBootWarmup().runPostListen();");
    expect(s0).toBeGreaterThanOrEqual(0);
    expect(portLine).toBeGreaterThan(s0); // S0 在 listen 参数解析（listen 前）之前
    expect(post).toBeGreaterThan(portLine); // S1-S3 在 listen 之后
    expect(src.indexOf("this.getBootWarmup().runPreListen();", s0 + 1)).toBe(-1); // 仅一处
    expect(src.includes("startRerankWarmup")).toBe(false); // 旧 1×1 预热已被取代移除
  });

  it("/health 恒 200（无 readiness 硬门控）：handleHealth 不含 warmup 短路返回", () => {
    const at = src.indexOf("private async handleHealth");
    const handleHealth = src.slice(at, at + 6_000);
    expect(handleHealth).toContain("warmup: this.bootWarmup?.snapshot()");
    expect(handleHealth).toContain("sendJson(res, 200, response)");
    expect(handleHealth.includes("sendJson(res, 503")).toBe(false);
  });
});
