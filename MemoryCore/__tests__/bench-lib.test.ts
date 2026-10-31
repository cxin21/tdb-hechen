/**
 * bench harness 技术债（issue #139）叶模块单测：
 *  - retry.mjs：429 退避单一源，末次不白等、不可重试立即抛；
 *  - tokens.mjs：provider 不报 usage 时的确定性估算与归一化；
 *  - cache.mjs：三件套合一的路径/读/原子写契约。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RATE_LIMIT_DELAYS_MS,
  isRateLimitError,
  isRetriableHttpError,
  withRateLimitRetry,
} from "../scripts/lib/bench/retry.mjs";
import {
  TOKEN_ESTIMATOR_VERSION,
  addUsage,
  emptyUsageTotal,
  estimateMessagesTokens,
  estimateTokens,
  normalizeUsage,
} from "../scripts/lib/bench/tokens.mjs";
import {
  cacheDirExists,
  cacheFileOf,
  readCache,
  sanitizeCaseId,
  writeCache,
} from "../scripts/lib/bench/cache.mjs";
import { embedWithRetry, isRetriableEmbedError } from "../scripts/lib/bench/store.mjs";
import { createArgReader } from "../scripts/lib/bench/argv.mjs";

const tmpDirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "bench-lib-test-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

function rateLimited(): Error {
  return new Error("LLM HTTP 429: rate limit exceeded");
}

describe("retry.mjs / withRateLimitRetry", () => {
  it("首次成功不 sleep、不重试", async () => {
    const sleep = vi.fn(async () => {});
    const fn = vi.fn(async () => "ok");
    const out = await withRateLimitRetry(fn, { sleep });
    expect(out).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("429 后重试并按历史刻度退避（5s/15s）", async () => {
    const sleep = vi.fn(async () => {});
    let n = 0;
    const fn = vi.fn(async () => {
      n++;
      if (n < 3) throw rateLimited();
      return "ok";
    });
    await expect(withRateLimitRetry(fn, { sleep })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([RATE_LIMIT_DELAYS_MS[0], RATE_LIMIT_DELAYS_MS[1]]);
  });

  it("末次失败立即抛，不再白等 30s（#139 第1项核心）", async () => {
    const sleep = vi.fn(async () => {});
    const fn = vi.fn(async () => {
      throw rateLimited();
    });
    await expect(withRateLimitRetry(fn, { sleep })).rejects.toThrow(/429/);
    expect(fn).toHaveBeenCalledTimes(4);
    // 4 次尝试 → 3 次 sleep（第 4 次失败后不 sleep）
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual(RATE_LIMIT_DELAYS_MS);
  });

  it("不可重试错误立即抛出，不被退避吞掉", async () => {
    const sleep = vi.fn(async () => {});
    const fn = vi.fn(async () => {
      throw new Error("LLM HTTP 400: bad request");
    });
    await expect(withRateLimitRetry(fn, { sleep })).rejects.toThrow(/400/);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("空响应（isEmpty）视为失败并重试，耗尽后抛指定文案", async () => {
    const sleep = vi.fn(async () => {});
    const fn = vi.fn(async () => ({ data: null }));
    await expect(
      withRateLimitRetry(fn, { sleep, isEmpty: (v: any) => !v?.data, emptyMessage: "empty/unparsable response" }),
    ).rejects.toThrow(/empty\/unparsable response/);
    expect(fn).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("onRetry 每次退避回调一次，带 attempt/delay/error", async () => {
    const sleep = vi.fn(async () => {});
    const onRetry = vi.fn();
    let n = 0;
    await withRateLimitRetry(
      async () => {
        n++;
        if (n === 1) throw rateLimited();
        return 1;
      },
      { sleep, onRetry },
    );
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0][0]).toMatchObject({ attempt: 0, delay: RATE_LIMIT_DELAYS_MS[0] });
  });

  it("非法 attempts 立即报错（不静默降级）", async () => {
    await expect(withRateLimitRetry(async () => 1, { attempts: 0 })).rejects.toThrow(/attempts/);
  });

  it("isRateLimitError / isRetriableHttpError 判定", () => {
    expect(isRateLimitError(rateLimited())).toBe(true);
    expect(isRateLimitError(new Error("Too Many Requests"))).toBe(true);
    expect(isRateLimitError(new Error("boom"))).toBe(false);
    expect(isRetriableHttpError(Object.assign(new Error("x"), { status: 429 }))).toBe(true);
    expect(isRetriableHttpError(Object.assign(new Error("x"), { status: 503 }))).toBe(true);
    expect(isRetriableHttpError(Object.assign(new Error("x"), { status: 400 }))).toBe(false);
  });
});

describe("tokens.mjs", () => {
  it("CJK 按字符计、拉丁按 3.6 字符/token，确定性", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("中文四字")).toBe(4);
    expect(estimateTokens("abcdefghij")).toBe(Math.ceil(10 / 3.6));
    expect(estimateTokens("中文 four")).toBe(2 + Math.ceil(5 / 3.6));
    expect(estimateTokens("中文 four")).toBe(estimateTokens("中文 four"));
  });

  it("报告了 usage → 原样采用，不估算", () => {
    const u = normalizeUsage({ prompt_tokens: 120, completion_tokens: 30 }, { promptText: "x" });
    expect(u).toMatchObject({ prompt: 120, completion: 30, reported: true, estimated: false });
  });

  it("usage 缺失/全 0 → 估算并标注 estimated（缓存档 token 判定的基础）", () => {
    const u = normalizeUsage({ prompt_tokens: 0, completion_tokens: 0 }, { promptText: "中文中文", completionText: "ok" });
    expect(u.reported).toBe(false);
    expect(u.estimated).toBe(true);
    expect(u.method).toBe(TOKEN_ESTIMATOR_VERSION);
    expect(u.prompt).toBe(4);
    expect(u.completion).toBe(1);
  });

  it("既无 usage 也无兜底文本 → 全 0 且不标 estimated（不造假精度）", () => {
    expect(normalizeUsage(null, {})).toMatchObject({ prompt: 0, completion: 0, reported: false, estimated: false });
  });

  it("messages 估算含结构开销", () => {
    const plain = estimateMessagesTokens([{ role: "user", content: "abcd" }]);
    expect(plain).toBe(Math.ceil(4 / 3.6) + 4);
  });

  it("addUsage/emptyUsageTotal 累加并计来源", () => {
    const t = emptyUsageTotal();
    addUsage(t, { prompt: 10, completion: 2, reported: true });
    addUsage(t, { prompt: 5, completion: 1, estimated: true });
    expect(t).toMatchObject({ prompt: 15, completion: 3, reportedCalls: 1, estimatedCalls: 1 });
  });
});

describe("cache.mjs", () => {
  it("sanitizeCaseId 与非安全字符归一", () => {
    expect(sanitizeCaseId("lme/001:abc")).toBe("lme_001_abc");
    expect(cacheFileOf("/tmp/x", "facts", "a b")).toBe(path.join("/tmp/x", "facts", "a_b.json"));
  });

  it("writeCache → readCache 往返，且校验函数可拒绝旧版本", () => {
    const dir = tmpDir();
    expect(readCache(dir, "facts", "c1")).toBeNull();
    writeCache(dir, "facts", "c1", { promptVersion: "facts-v2", byTurn: {} });
    const hit = readCache(dir, "facts", "c1", (p: any) => p?.promptVersion === "facts-v2");
    expect(hit?.payload.promptVersion).toBe("facts-v2");
    expect(readCache(dir, "facts", "c1", (p: any) => p?.promptVersion === "facts-v1")).toBeNull();
    expect(cacheDirExists(dir, "facts")).toBe(true);
    expect(cacheDirExists(dir, "nope")).toBe(false);
  });

  it("坏 JSON 返回 null 不抛（并回调 onError）", () => {
    const dir = tmpDir();
    const f = cacheFileOf(dir, "conclusions", "bad");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, "{not json", "utf8");
    const onError = vi.fn();
    expect(readCache(dir, "conclusions", "bad", undefined, onError)).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("并发写同一 case 不互踩、不留 .tmp 残渣（原子写）", async () => {
    const dir = tmpDir();
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        Promise.resolve().then(() => writeCache(dir, "facts", "same", { promptVersion: "facts-v2", i })),
      ),
    );
    const files = fs.readdirSync(path.join(dir, "facts"));
    expect(files.filter((f) => f.includes(".tmp"))).toEqual([]);
    const hit = readCache(dir, "facts", "same", () => true);
    expect(hit?.payload.promptVersion).toBe("facts-v2");
  });

  it("写入失败抛给调用方（不再静默吞掉缓存腐化）", () => {
    const dir = tmpDir();
    const frozen = path.join(dir, "ro");
    fs.mkdirSync(frozen, { recursive: true });
    const f = cacheFileOf(frozen, "facts", "x");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.mkdirSync(f); // 目录占位 → rename 必失败
    expect(() => writeCache(frozen, "facts", "x", { a: 1 })).toThrow();
  });
});

describe("store.mjs / embedWithRetry 可重试判定（#160 第1项）", () => {
  it("5xx 可重试、其余 4xx 不可重试（状态码口径）", () => {
    expect(isRetriableEmbedError(Object.assign(new Error("x"), { status: 500 }))).toBe(true);
    expect(isRetriableEmbedError(Object.assign(new Error("x"), { status: 502 }))).toBe(true);
    expect(isRetriableEmbedError(Object.assign(new Error("x"), { status: 503 }))).toBe(true);
    expect(isRetriableEmbedError(Object.assign(new Error("x"), { status: 400 }))).toBe(false);
  });

  it("无状态码时按文案判 5xx（历史 5dd 笔误的回归点）", () => {
    expect(isRetriableEmbedError(new Error("HTTP 502 Bad Gateway"))).toBe(true);
    expect(isRetriableEmbedError(new Error("embedding 503"))).toBe(true);
    expect(isRetriableEmbedError(new Error("socket hang up"))).toBe(true);
    expect(isRetriableEmbedError(new Error("ETIMEDOUT"))).toBe(true);
    expect(isRetriableEmbedError(new Error("HTTP 429 Too Many Requests"))).toBe(true);
    expect(isRetriableEmbedError(new Error("rate limit exceeded"))).toBe(true);
    expect(isRetriableEmbedError(new Error("HTTP 400 Bad Request"))).toBe(false);
    // 「输入条数超限」不是限流：无状态码时也不能靠 too many 兜进重试
    expect(isRetriableEmbedError(new Error("too many inputs"))).toBe(false);
  });

  it("有状态码时状态码口径优先于文案（400 + too many requests 也不重试）", () => {
    expect(isRetriableEmbedError(Object.assign(new Error("too many requests"), { status: 400 }))).toBe(false);
    expect(isRetriableEmbedError(Object.assign(new Error("too many requests"), { status: 429 }))).toBe(true);
  });

  it("四位数字串不被误判成 5xx（retry after 5000ms ≠ HTTP 500）", () => {
    expect(isRetriableEmbedError(new Error("retry after 5000ms"))).toBe(false);
  });

  it("embedWithRetry 对无状态码的 5xx 文案同样重试（text-only 路径）", async () => {
    let n = 0;
    const flaky = {
      embedBatch: async () => {
        n++;
        if (n < 2) throw new Error("HTTP 502 Bad Gateway");
        return [[0.3]];
      },
    };
    await expect(embedWithRetry(flaky, ["t"], { tries: 3, baseMs: 1, minIntervalMs: 0 })).resolves.toEqual([[0.3]]);
    expect(n).toBe(2);
  });

  it("embedWithRetry 在 503 上重试、400 上立即抛出", async () => {
    let n = 0;
    const flaky = {
      embedBatch: async () => {
        n++;
        if (n < 3) throw Object.assign(new Error("gateway"), { status: 503 });
        return [[0.1, 0.2]];
      },
    };
    await expect(embedWithRetry(flaky, ["t"], { tries: 3, baseMs: 1, minIntervalMs: 0 })).resolves.toEqual([[0.1, 0.2]]);
    expect(n).toBe(3);

    let m = 0;
    const bad = {
      embedBatch: async () => {
        m++;
        throw Object.assign(new Error("HTTP 400: too many inputs"), { status: 400 });
      },
    };
    await expect(embedWithRetry(bad, ["t"], { tries: 3, baseMs: 1, minIntervalMs: 0 })).rejects.toThrow(/400/);
    expect(m).toBe(1);
  });
});

describe("argv.mjs / bench 取参（#160 第4项）", () => {
  const exitThrow = () =>
    vi.fn((code: number) => {
      throw new Error("exit " + code);
    });

  it("正常取值与缺省", () => {
    const r = createArgReader(["--k", "3", "--dataset", "locomo"]);
    expect(r.num("k", 5)).toBe(3);
    expect(r.num("limit", 7)).toBe(7);
    expect(r.strArg("dataset", "")).toBe("locomo");
    expect(r.flag("k")).toBe(true);
    expect(r.flag("nope")).toBe(false);
    expect(r.arg("missing")).toBeUndefined();
  });

  it("裸 flag：arg 返回 true，但 num/strArg 必须 exit 2（不静默 NaN/默认值）", () => {
    const exit = exitThrow();
    const logError = vi.fn();
    const r = createArgReader(["--k", "--dataset"], { exit, logError });
    expect(r.arg("k", undefined)).toBe(true);
    expect(() => r.num("k", 5)).toThrow(/exit 2/);
    expect(exit).toHaveBeenCalledWith(2);
    expect(logError.mock.calls[0][0]).toMatch(/--k 需要一个数值/);
  });

  it("--k 在行尾（后面到底）同样 exit 2", () => {
    const exit = exitThrow();
    const logError = vi.fn();
    const r = createArgReader(["--k"], { exit, logError });
    expect(() => r.num("k", 5)).toThrow(/exit 2/);
    expect(logError.mock.calls[0][0]).toMatch(/裸 flag/);
  });

  it("非数值取值也 exit 2（不回退成 NaN）", () => {
    const exit = exitThrow();
    const logError = vi.fn();
    const r = createArgReader(["--k", "abc"], { exit, logError });
    expect(() => r.num("k", 5)).toThrow(/exit 2/);
    expect(logError.mock.calls[0][0]).toMatch(/需要数值/);
  });

  it("strArg 裸 flag 与历史文案一致（exit 2）", () => {
    const exit = exitThrow();
    const logError = vi.fn();
    const r = createArgReader(["--dataset"], { exit, logError });
    expect(() => r.strArg("dataset", "")).toThrow(/exit 2/);
    expect(logError.mock.calls[0][0]).toMatch(/需要一个值/);
  });
});
