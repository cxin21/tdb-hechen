/**
 * CR-7 / task-36 回归测试：请求体超过 MAX_BODY_BYTES 时必须拿到
 * HTTP 413 + JSON（limitBytes/hint 可诊断），而不是连接被重置。
 *
 * 修前行为：parseJsonBody 在 reject 之后立刻 `req.resume(); req.destroy()`，
 * socket 在 413 写出前消失 —— 客户端（undici/fetch、curl）只看到
 * `TypeError: fetch failed` / `ECONNRESET`，传输层把可诊断错误降级成网络故障。
 * 真请求（非 mock）覆盖四条路径：
 *   1. 带 Content-Length 的 1.2 MB 上传（fetch / undici）
 *   2. 不带 Content-Length 的 chunked 上传（http.request）
 *   3. gzip 炸弹：压缩后很小、解压后超限（走解压流 → drainOversizeBody 的 source.destroy 分支）
 *   4. 未超限正常通过（防止把限制改成"一律拒绝"）
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { parseJsonBody, PayloadTooLargeError } from "../server.js";
import { DEFAULT_MAX_BODY_BYTES } from "../../utils/env-config.js";

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    try {
      await parseJsonBody<Record<string, unknown>>(req);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        // 与 gateway 顶层 catch 同形：先写 JSON，再关连接。
        res.setHeader("Connection", "close");
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: err.message,
          code: 413,
          limitBytes: err.limitBytes,
          hint: "Split the batch into several smaller requests.",
        }));
        return;
      }
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** 1.2 MiB 的合法 JSON（略大于缺省 1 MiB 上限）。 */
function oversizeJson(bytes = 1_200_000): string {
  return JSON.stringify({ blob: "x".repeat(bytes) });
}

describe("parseJsonBody: 超限体回 413 而非断连（task-36 / CR-7）", () => {
  it("带 Content-Length 的 1.2 MB 上传：HTTP 413 + limitBytes + Connection: close", async () => {
    const body = oversizeJson();
    expect(Buffer.byteLength(body)).toBeGreaterThan(DEFAULT_MAX_BODY_BYTES);

    const res = await fetch(`${baseUrl}/upload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    expect(res.status).toBe(413);
    expect(res.headers.get("connection")).toBe("close");
    const json = (await res.json()) as { error: string; code: number; limitBytes: number; hint?: string };
    expect(json.code).toBe(413);
    expect(json.limitBytes).toBe(DEFAULT_MAX_BODY_BYTES);
    expect(json.error).toContain(String(DEFAULT_MAX_BODY_BYTES));
    expect(json.hint).toBeTruthy();
  });

  it("不带 Content-Length 的 chunked 上传：同样回 413（累计长度分支不 destroy socket）", async () => {
    const chunk = "y".repeat(64 * 1024);
    const chunkCount = Math.ceil(1_200_000 / chunk.length);

    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(`${baseUrl}/chunked`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      }, (res) => {
        let data = "";
        res.setEncoding("utf-8");
        res.on("data", (d: string) => { data += d; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      });
      req.on("error", reject);
      // 逐块写入，故意不设 content-length ⇒ transfer-encoding: chunked。
      for (let i = 0; i < chunkCount; i += 1) req.write(`"${chunk}"`);
      req.write("\n");
      req.end();
    });

    expect(result.status).toBe(413);
    const json = JSON.parse(result.body) as { code: number; limitBytes: number };
    expect(json.code).toBe(413);
    expect(json.limitBytes).toBe(DEFAULT_MAX_BODY_BYTES);
  });

  it("gzip 炸弹（压缩后很小、解压后超限）：回 413 且不泄漏/不挂死", async () => {
    const plain = oversizeJson(1_500_000);
    const gz = gzipSync(Buffer.from(plain, "utf-8"));
    // 前置条件：压缩后远小于上限，所以走的是"解压流累计超限"分支。
    expect(gz.byteLength).toBeLessThan(DEFAULT_MAX_BODY_BYTES);
    expect(Buffer.byteLength(plain)).toBeGreaterThan(DEFAULT_MAX_BODY_BYTES);

    const res = await fetch(`${baseUrl}/gzip`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      body: gz,
    });

    expect(res.status).toBe(413);
    const json = (await res.json()) as { code: number };
    expect(json.code).toBe(413);
  });

  it("未超限请求照常 200（限制不是一律拒绝）", async () => {
    const res = await fetch(`${baseUrl}/small`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
