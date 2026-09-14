import { test, expect } from "vitest";
import { createServer, type Server } from "node:http";
import { WikiEmbeddingClient } from "../src/engines/wiki/embedding-client.js";

/**
 * 回归：embed() 必须把超过模型字节上限(100KB)的超长页面正文截断，否则火山 API 返回 400
 *   InvalidParameter "string too long"。见 index.md 208KB 触发 400 的真实缺陷。
 * mock embedding 服务回传它收到的 input[0] 字节数，我们用此断言发送体被截断到安全上限内。
 */
function startEchoByteServer() {
  let receivedBytes = 0;
  const seen: number[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.resume();
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      try {
        const b = JSON.parse(raw);
        const t = Array.isArray(b.input) ? String(b.input[0] ?? "") : String(b.input ?? "");
        receivedBytes = Buffer.byteLength(t, "utf8");
        seen.push(receivedBytes);
      } catch { receivedBytes = -1; }
      res.writeHead(200, { "Content-Type": "application/json" });
      // 返回固定 2 维向量，唯一定向 embed() 走完请求解析
      res.end(JSON.stringify({ data: [{ embedding: [0.5, 0.5] }] }));
    });
  });
  return new Promise<{ url: string; seen: () => number[]; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        seen: () => seen,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

test("embed() truncates oversized page content to within model byte limit", async () => {
  const mock = await startEchoByteServer();
  try {
    const client = new WikiEmbeddingClient({
      provider: "openai_compatible",
      baseUrl: mock.url,
      apiKey: "k",
      model: "m",
      dimensions: 2,
    });
    // 模拟 index.md：208525 字节 ← 触发过 400 的真实长度
    const huge = "文".repeat(70_000); // 70000 中文 ≈ 210000 字节, > 100000 上限
    await client.embed(huge);
    const sizes = mock.seen();
    expect(sizes.length).toBe(1);
    const sent = sizes[0];
    // 断言：发送的字节数必须 ≤ 模型上限(100000)，否则会 400。
    expect(sent).toBeLessThanOrEqual(100_000);
    expect(sent).toBeLessThan(Buffer.byteLength(huge, "utf8"));
  } finally {
    await mock.close();
  }
});