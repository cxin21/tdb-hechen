/**
 * P1 task-3 下载器 live 集成：真实 node:http loopback 服务器 + 真实 globalThis.fetch。
 *
 * 门槛（brief/mission）：下载器必须在**本地静态服务器**上证明 Range 断点续传与
 * 退避重试路径——测试**绝不触达真实 hf-mirror/ModelScope**（全程 127.0.0.1）。
 * 单元套件（rerank-downloader.test.ts）用 mock fetch 覆盖分支矩阵；本套件补
 * 真实 socket/流式管线（createWriteStream/pipeline/Content-Length 对账）。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

import {
  DEFAULT_RERANK_REPO,
  RerankModelDownloader,
  getRerankModelStatus,
  isRerankModelReady,
  resetRerankDownloadStateForTests,
  startRerankModelDownload,
} from "../downloader.js";
import type { RerankModelFileSpec } from "../downloader.js";

const BODIES: Record<string, string> = {
  "config.json": '{"model_type":"seqcls"}',
  "tokenizer.json": JSON.stringify({ vocab: "x".repeat(52) }),
  "tokenizer_config.json": '{"do_lower_case":true}',
  "special_tokens_map.json": '{"unk_token":"[UNK]"}',
  "onnx/model_quantized.onnx": "ONNX01234",
};

const TINY_MODEL_FILES: RerankModelFileSpec[] = [
  { rel: "config.json", minBytes: 1 },
  { rel: "tokenizer.json", minBytes: 1 },
  { rel: "tokenizer_config.json", minBytes: 1 },
  { rel: "special_tokens_map.json", minBytes: 1 },
  { rel: "onnx/model_quantized.onnx", minBytes: 5 },
];

interface ReqRecord {
  rel: string;
  ua: string;
  range: string | null;
  host: string;
}

/** 本地 fixture 服务器：支持 Range 206、可配置 N 次 429 后 200。 */
function startFixtureServer(): Promise<{
  port: number;
  requests: ReqRecord[];
  reset: () => void;
  set429Then200: (rel: string, n429: number) => void;
  close: () => Promise<void>;
}> {
  const requests: ReqRecord[] = [];
  const counter429 = new Map<string, { remain: number }>();
  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    const m = /\/resolve\/(?:main|master)\/(.+)$/.exec(url);
    const rel = m ? m[1] : url.replace(/^\/+/, "");
    requests.push({ rel, ua: req.headers["user-agent"] ?? "", range: req.headers.range ?? null, host: req.headers.host ?? "" });
    const flaky = counter429.get(rel);
    if (flaky && flaky.remain > 0) {
      flaky.remain -= 1;
      res.writeHead(429, { "Content-Length": "0" });
      res.end();
      return;
    }
    const body = Buffer.from(BODIES[rel] ?? "", "utf-8");
    const range = req.headers.range;
    if (range) {
      const rm = /^bytes=(\d+)-$/.exec(range);
      const start = rm ? Number(rm[1]) : 0;
      res.writeHead(206, {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(body.length - start),
        "Content-Range": `bytes ${start}-${body.length - 1}/${body.length}`,
      });
      res.end(body.subarray(start));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(body.length) });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        requests,
        reset: () => {
          requests.length = 0;
          counter429.clear();
        },
        set429Then200: (rel, n429) => counter429.set(rel, { remain: n429 }),
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

describe("P1 task-3 下载器 live（loopback http + 真实 fetch）", () => {
  let srv: Awaited<ReturnType<typeof startFixtureServer>>;
  let tmpRoot: string;

  beforeAll(async () => {
    srv = await startFixtureServer();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rk3-live-"));
  });

  beforeEach(() => {
    resetRerankDownloadStateForTests();
    srv.reset();
  });

  afterAll(async () => {
    await srv.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function freshDir(): string {
    return fs.mkdtempSync(path.join(tmpRoot, "dl-"));
  }

  function makeDownloader(modelDir: string, extra?: { backoffBaseMs?: number }): RerankModelDownloader {
    return new RerankModelDownloader({
      modelDir,
      modelFiles: TINY_MODEL_FILES,
      hfBaseUrl: `http://127.0.0.1:${srv.port}`,
      modelScopeBaseUrl: `http://127.0.0.1:${srv.port}`,
      backoffBaseMs: extra?.backoffBaseMs ?? 1,
    });
  }

  it("happy path：5 文件落盘字节精确 + 浏览器 UA + 全程 127.0.0.1 + ready 判定", async () => {
    const dir = freshDir();
    const d = makeDownloader(dir);
    expect(await d.download()).toBe(true);
    for (const [rel, body] of Object.entries(BODIES)) {
      expect(fs.readFileSync(path.join(dir, ...rel.split("/")), "utf-8")).toBe(body);
    }
    expect(srv.requests.length).toBe(5);
    expect(srv.requests.every((r) => r.ua.startsWith("Mozilla/5.0"))).toBe(true);
    expect(srv.requests.every((r) => r.host.startsWith("127.0.0.1:"))).toBe(true);
    expect(isRerankModelReady(dir, TINY_MODEL_FILES)).toBe(true);
    expect(d.status().state).toBe("ready");
    expect(d.status().percent).toBe(100);
  });

  it("退避重试（真实 backoff sleep）：429×2 → 200，同文件恰 3 次请求，最终成功", async () => {
    const dir = freshDir();
    srv.set429Then200("tokenizer_config.json", 2);
    const d = makeDownloader(dir, { backoffBaseMs: 5 });
    expect(await d.download()).toBe(true);
    const hits = srv.requests.filter((r) => r.rel === "tokenizer_config.json");
    expect(hits.length).toBe(3);
    expect(fs.readFileSync(path.join(dir, "tokenizer_config.json"), "utf-8")).toBe(BODIES["tokenizer_config.json"]);
  });

  it("Range 断点续传：.part 4 字节 + 服务器 206 → 续传拼接正确、该文件仅 1 次请求（range bytes=4-）", async () => {
    const dir = freshDir();
    const rel = "onnx/model_quantized.onnx";
    fs.mkdirSync(path.join(dir, "onnx"), { recursive: true });
    fs.writeFileSync(path.join(dir, `${rel}.part`), Buffer.from(BODIES[rel].slice(0, 4), "utf-8"));
    const d = makeDownloader(dir);
    expect(await d.download()).toBe(true);
    const onnxHits = srv.requests.filter((r) => r.rel === rel);
    expect(onnxHits.length).toBe(1);
    expect(onnxHits[0].range).toBe("bytes=4-");
    expect(fs.readFileSync(path.join(dir, ...rel.split("/")), "utf-8")).toBe(BODIES[rel]);
    expect(fs.existsSync(path.join(dir, `${rel}.part`))).toBe(false);
  });

  it("startRerankModelDownload（单例入口）走 loopback：true + 注册表 ready + repo/modelDir 正确", async () => {
    const dir = freshDir();
    const ok = await startRerankModelDownload({
      modelDir: dir,
      modelFiles: TINY_MODEL_FILES,
      hfBaseUrl: `http://127.0.0.1:${srv.port}`,
      modelScopeBaseUrl: `http://127.0.0.1:${srv.port}`,
      backoffBaseMs: 1,
    });
    expect(ok).toBe(true);
    const snap = getRerankModelStatus();
    expect(snap.state).toBe("ready");
    expect(snap.repo).toBe(DEFAULT_RERANK_REPO);
    expect(path.resolve(snap.modelDir)).toBe(path.resolve(dir));
    expect(snap.files.every((f) => f.state === "done")).toBe(true);
  });
});
