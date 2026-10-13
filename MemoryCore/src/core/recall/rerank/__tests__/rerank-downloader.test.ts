/**
 * P1 召回质量（spec §4.4，task-3）：rerank 本地模型自动下载器 TDD。
 *
 * 合同（spec §4.4 / brief）：
 * - 文件清单固定 5 个（config.json / tokenizer.json / tokenizer_config.json /
 *   special_tokens_map.json / onnx/model_quantized.onnx），落盘 <modelDir>/ 相对路径。
 * - fetch 直链 + 浏览器 UA + 指数退避（429/5xx 可重试）+ Range 断点续传（.part 文件）。
 * - 双源：主 hf-mirror.com，备 ModelScope；单源重试穷尽后切换下一源。
 * - 校验（每文件 minBytes / Content-Length 一致性）失败 → 回滚（不留半成品 ready 态）。
 * - 状态可查询（单例注册表，无推送依赖，panel 轮询用）。
 * - 绝不使用 transformers.js 内建下载器（hf-mirror 429 已证）——本实现全部自管 HTTP。
 * 全部 HTTP 走注入 fetchImpl，零真实网络。测试注入 tiny modelFiles（真实清单 minBytes
 * 为 10MB/200MB 量级，单测用 1 字节门槛验证同一逻辑）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_RERANK_REPO,
  RerankModelDownloader,
  getRerankModelStatus,
  isRerankModelReady,
  resetRerankDownloadStateForTests,
  startRerankModelDownload,
  type RerankModelFileSpec,
} from "../downloader.js";

const TINY_MODEL_FILES: RerankModelFileSpec[] = [
  { rel: "config.json", minBytes: 1 },
  { rel: "tokenizer.json", minBytes: 1 },
  { rel: "tokenizer_config.json", minBytes: 1 },
  { rel: "special_tokens_map.json", minBytes: 1 },
  { rel: "onnx/model_quantized.onnx", minBytes: 1 },
];

const BROWSER_UA_PREFIX = "Mozilla/5.0";

interface CannedRoute {
  host: string;
  /** 返回 null = 让 fetch mock 落 404（模拟源不存在该文件）。 */
  respond: (url: string, init: RequestInit | undefined, file: string) => Response | null;
}

function makeFetchMock(routes: CannedRoute[], calls?: Array<{ url: string; headers: Record<string, string> }>): typeof fetch {
  return (async (url: unknown, init?: unknown) => {
    const u = String(url);
    const headerBag = new Headers((init as RequestInit | undefined)?.headers as HeadersInit | undefined);
    const headers: Record<string, string> = {};
    headerBag.forEach((v, k) => (headers[k.toLowerCase()] = v));
    calls?.push({ url: u, headers });
    // file = resolve/main|master 之后的 rel 全路径（onnx 在 onnx/ 子目录——basename 提取
    // 会丢目录段，与 writeAllValid/断言的 valid:<rel> 体对不上；scaffold 修正）。
    const file = u.includes("/resolve/main/")
      ? (u.split("/resolve/main/")[1] ?? "")
      : u.includes("/resolve/master/")
        ? (u.split("/resolve/master/")[1] ?? "")
        : (u.split("/").pop() ?? "");
    for (const route of routes) {
      if (u.includes(route.host)) {
        const resp = route.respond(u, init as RequestInit | undefined, file);
        if (resp) return resp;
      }
    }
    return new Response("mock: not found", { status: 404 });
  }) as unknown as typeof fetch;
}

const ok200 = (body: string, opts?: { total?: number }) =>
  new Response(body, {
    status: 200,
    headers: { "Content-Length": String(opts?.total ?? body.length) },
  });

async function seedPart(modelDir: string, rel: string, content: string): Promise<string> {
  const part = path.join(modelDir, `${rel}.part`);
  fs.mkdirSync(path.dirname(part), { recursive: true });
  fs.writeFileSync(part, content, "utf-8");
  return part;
}

function fullValidBody(rel: string): string {
  return `valid:${rel}:${"x".repeat(64)}`;
}

function writeAllValid(modelDir: string): void {
  for (const spec of TINY_MODEL_FILES) {
    fs.mkdirSync(path.join(modelDir, path.dirname(spec.rel)), { recursive: true });
    fs.writeFileSync(path.join(modelDir, spec.rel), fullValidBody(spec.rel), "utf-8");
  }
}

let tmpRoot: string;
let modelDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rk3-dl-"));
  modelDir = path.join(tmpRoot, "models", "reranker", DEFAULT_RERANK_REPO);
  resetRerankDownloadStateForTests();
});

afterEach(() => {
  resetRerankDownloadStateForTests();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("P1 task-3 下载器：基础合同", () => {
  it("全 200 快乐路：5 文件落盘、UA 为浏览器 UA、status ready、percent 100", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = makeFetchMock(
      [{ host: "hf-mirror.com", respond: (_u, _i, file) => ok200(fullValidBody(file)) }],
      calls,
    );
    const dl = new RerankModelDownloader({ modelDir, fetchImpl, backoffBaseMs: 1, modelFiles: TINY_MODEL_FILES });
    const ok = await dl.download();
    expect(ok).toBe(true);
    for (const spec of TINY_MODEL_FILES) {
      expect(fs.readFileSync(path.join(modelDir, spec.rel), "utf-8")).toBe(fullValidBody(spec.rel));
    }
    expect(calls.length).toBe(TINY_MODEL_FILES.length);
    expect(calls[0].headers["user-agent"].startsWith(BROWSER_UA_PREFIX)).toBe(true);
    expect(calls[0].url.startsWith("https://hf-mirror.com/")).toBe(true);
    expect(calls[0].url).toContain(`${DEFAULT_RERANK_REPO}/resolve/main/`);
    const st = dl.status();
    expect(st.state).toBe("ready");
    expect(st.percent).toBe(100);
    expect(st.error).toBeNull();
    expect(st.finishedAt).toBeTruthy();
  });

  it("文件已齐且过校验 → 直接 ready，零网络", async () => {
    writeAllValid(modelDir);
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = makeFetchMock([{ host: "hf-mirror.com", respond: () => ok200("x") }], calls);
    const dl = new RerankModelDownloader({ modelDir, fetchImpl, backoffBaseMs: 1, modelFiles: TINY_MODEL_FILES });
    const ok = await dl.download();
    expect(ok).toBe(true);
    expect(calls.length).toBe(0);
    expect(isRerankModelReady(modelDir, TINY_MODEL_FILES)).toBe(true);
  });

  it("isRerankModelReady：缺文件 / 低于 minBytes 均 false（真实清单口径）", () => {
    expect(isRerankModelReady(modelDir)).toBe(false);
    fs.mkdirSync(path.join(modelDir, "onnx"), { recursive: true });
    fs.writeFileSync(path.join(modelDir, "config.json"), fullValidBody("a"), "utf-8");
    expect(isRerankModelReady(modelDir)).toBe(false);
  });
});

describe("P1 task-3 下载器：重试 / 续传 / 双源", () => {
  it("429 指数退避重试：两次 429 后 200 → 成功且同文件共 3 次请求", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    let tokenizerHits = 0;
    const fetchImpl = makeFetchMock([
      {
        host: "hf-mirror.com",
        respond: (_u, _i, file) => {
          if (file !== "tokenizer.json") return ok200(fullValidBody(file));
          tokenizerHits += 1;
          if (tokenizerHits <= 2) return new Response("rate limited", { status: 429 });
          return ok200(fullValidBody(file));
        },
      },
    ], calls);
    const dl = new RerankModelDownloader({ modelDir, fetchImpl, backoffBaseMs: 1, maxRetriesPerSource: 3, modelFiles: TINY_MODEL_FILES });
    const ok = await dl.download();
    expect(ok).toBe(true);
    const tokenizerCalls = calls.filter((c) => c.url.endsWith("/tokenizer.json"));
    expect(tokenizerCalls.length).toBe(3);
  });

  it("Range 断点续传：.part 存在 → 带 Range 头请求、206 追加、不重下全量", async () => {
    const part = await seedPart(modelDir, "onnx/model_quantized.onnx", "AAAA");
    expect(fs.statSync(part).size).toBe(4);
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const TOTAL = 9;
    const fetchImpl = makeFetchMock(
      [
        {
          host: "hf-mirror.com",
          respond: (_u, init, file) => {
            if (file.split("/").pop() !== "model_quantized.onnx") return ok200(fullValidBody(file));
            const range = new Headers((init as RequestInit | undefined)?.headers as HeadersInit | undefined).get("range");
            if (range !== "bytes=4-") return new Response("expected range", { status: 400 });
            return new Response("BBBBB", {
              status: 206,
              headers: { "Content-Range": `bytes 4-${TOTAL - 1}/${TOTAL}`, "Content-Length": "5" },
            });
          },
        },
      ],
      calls,
    );
    const dl = new RerankModelDownloader({ modelDir, fetchImpl, backoffBaseMs: 1, modelFiles: TINY_MODEL_FILES });
    const ok = await dl.download();
    expect(ok).toBe(true);
    const onnx = fs.readFileSync(path.join(modelDir, "onnx", "model_quantized.onnx"), "utf-8");
    expect(onnx).toBe("AAAABBBBB");
    const onnxCalls = calls.filter((c) => c.url.endsWith("model_quantized.onnx"));
    expect(onnxCalls.length).toBe(1); // 续传一次拿尾部，未重下全量
    expect(onnxCalls[0].headers["range"]).toBe("bytes=4-");
  });

  it("续传请求遇 200（源不支持 Range）→ 丢弃旧 .part 从头重下，内容不被拼接污染", async () => {
    await seedPart(modelDir, "tokenizer.json", "STALE-");
    const fetchImpl = makeFetchMock([
      { host: "hf-mirror.com", respond: (_u, _i, file) => ok200(fullValidBody(file)) },
    ]);
    const dl = new RerankModelDownloader({ modelDir, fetchImpl, backoffBaseMs: 1, modelFiles: TINY_MODEL_FILES });
    const ok = await dl.download();
    expect(ok).toBe(true);
    expect(fs.readFileSync(path.join(modelDir, "tokenizer.json"), "utf-8")).toBe(fullValidBody("tokenizer.json"));
  });

  it("双源切换：主源对某文件持续 404（fatal）→ 换 ModelScope 成功", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = makeFetchMock(
      [
        {
          host: "hf-mirror.com",
          respond: (_u, _i, file) => (file === "special_tokens_map.json" ? null : ok200(fullValidBody(file))),
        },
        { host: "modelscope.cn", respond: (_u, _i, file) => ok200(fullValidBody(file)) },
      ],
      calls,
    );
    const dl = new RerankModelDownloader({ modelDir, fetchImpl, backoffBaseMs: 1, maxRetriesPerSource: 0, modelFiles: TINY_MODEL_FILES });
    const ok = await dl.download();
    expect(ok).toBe(true);
    const stm = calls.filter((c) => c.url.endsWith("special_tokens_map.json"));
    expect(stm.some((c) => c.url.includes("hf-mirror.com"))).toBe(true);
    expect(stm.some((c) => c.url.includes("modelscope.cn/models/"))).toBe(true);
    expect(stm[stm.length - 1].url).toContain("/resolve/master/");
  });

  it("双源全部穷尽 → download false、status failed、.part 清理、不置 ready", async () => {
    await seedPart(modelDir, "config.json", "PARTIAL");
    const fetchImpl = makeFetchMock([
      { host: "hf-mirror.com", respond: () => new Response("rate limited", { status: 429 }) },
      { host: "modelscope.cn", respond: () => new Response("boom", { status: 500 }) },
    ]);
    const dl = new RerankModelDownloader({ modelDir, fetchImpl, backoffBaseMs: 1, maxRetriesPerSource: 1, modelFiles: TINY_MODEL_FILES });
    const ok = await dl.download();
    expect(ok).toBe(false);
    const st = dl.status();
    expect(st.state).toBe("failed");
    expect(st.error).toBeTruthy();
    expect(isRerankModelReady(modelDir, TINY_MODEL_FILES)).toBe(false);
    // .part 已回滚清理
    expect(fs.existsSync(path.join(modelDir, "config.json.part"))).toBe(false);
    expect(fs.existsSync(path.join(modelDir, "config.json"))).toBe(false);
  });
});

describe("P1 task-3 下载器：校验与回滚", () => {
  it("内容低于 minBytes（校验失败）→ false、回滚本 run 写入的目标文件、不留 ready", async () => {
    const fetchImpl = makeFetchMock([
      // 全部文件返回极小体：过 Content-Length 一致性，但过不了 minBytes 校验（门槛 100 字节）
      { host: "hf-mirror.com", respond: (_u, _i, file) => ok200(`t:${file}`) },
    ]);
    const dl = new RerankModelDownloader({
      modelDir,
      fetchImpl,
      backoffBaseMs: 1,
      maxRetriesPerSource: 1,
      modelFiles: TINY_MODEL_FILES.map((s) => ({ rel: s.rel, minBytes: 100 })),
    });
    const ok = await dl.download();
    expect(ok).toBe(false);
    expect(dl.status().state).toBe("failed");
    for (const spec of TINY_MODEL_FILES) {
      expect(fs.existsSync(path.join(modelDir, spec.rel))).toBe(false);
      expect(fs.existsSync(path.join(modelDir, `${spec.rel}.part`))).toBe(false);
    }
    expect(isRerankModelReady(modelDir, TINY_MODEL_FILES.map((s) => ({ rel: s.rel, minBytes: 2 })))).toBe(false);
  });

  it("体长与 Content-Length 不一致（截断流）→ 可重试错误，穷尽后失败", async () => {
    let n = 0;
    const fetchImpl = makeFetchMock([
      {
        host: "hf-mirror.com",
        respond: (_u, _i, file) => {
          if (file.split("/").pop() !== "tokenizer.json") return ok200(fullValidBody(file));
          n += 1;
          // 声称 100 字节，只给 5 字节
          return new Response("abcde", { status: 200, headers: { "Content-Length": "100" } });
        },
      },
    ]);
    const dl = new RerankModelDownloader({ modelDir, fetchImpl, backoffBaseMs: 1, maxRetriesPerSource: 1, modelFiles: TINY_MODEL_FILES });
    const ok = await dl.download();
    expect(ok).toBe(false);
    expect(n).toBeGreaterThanOrEqual(2);
    expect(dl.status().state).toBe("failed");
  });
});

describe("P1 task-3 下载器：单例状态注册表（panel 轮询面）", () => {
  it("startRerankModelDownload：下载中 status=downloading（含 file/percent），完成 → ready", async () => {
    const fetchImpl = makeFetchMock([
      { host: "hf-mirror.com", respond: (_u, _i, file) => ok200(fullValidBody(file)) },
    ]);
    const done = startRerankModelDownload({ modelDir, fetchImpl, backoffBaseMs: 1, modelFiles: TINY_MODEL_FILES });
    // 轮询等到 downloading 态（file 指向当前文件、percent 0-100）
    await vi.waitFor(() => {
      const st = getRerankModelStatus();
      expect(st.state === "downloading" || st.state === "ready").toBe(true);
    });
    expect(await done).toBe(true);
    const st = getRerankModelStatus();
    expect(st.state).toBe("ready");
    expect(st.percent).toBe(100);
    expect(st.modelDir).toBe(modelDir);
    expect(st.repo).toBe(DEFAULT_RERANK_REPO);
    expect(st.files).toHaveLength(TINY_MODEL_FILES.length);
    expect(st.files.every((f) => f.state === "done")).toBe(true);
  });

  it("并发 startRerankModelDownload 去重：共享同一进行中的下载", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = makeFetchMock(
      [{ host: "hf-mirror.com", respond: (_u, _i, file) => ok200(fullValidBody(file)) }],
      calls,
    );
    const p1 = startRerankModelDownload({ modelDir, fetchImpl, backoffBaseMs: 1, modelFiles: TINY_MODEL_FILES });
    const p2 = startRerankModelDownload({ modelDir, fetchImpl, backoffBaseMs: 1, modelFiles: TINY_MODEL_FILES });
    expect(await p1).toBe(true);
    expect(await p2).toBe(true);
    expect(calls.length).toBe(TINY_MODEL_FILES.length); // 第二个调用未触发第二遍下载
  });

  it("模型已就绪时 startRerankModelDownload 幂等 ready，零网络", async () => {
    writeAllValid(modelDir);
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = makeFetchMock([{ host: "hf-mirror.com", respond: () => ok200("x") }], calls);
    expect(await startRerankModelDownload({ modelDir, fetchImpl, modelFiles: TINY_MODEL_FILES })).toBe(true);
    expect(calls.length).toBe(0);
  });

  it("状态快照为副本：调用方改动不影响注册表", async () => {
    const snap = getRerankModelStatus();
    snap.state = "ready";
    expect(getRerankModelStatus().state).not.toBe("ready");
  });
});
