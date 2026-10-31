/**
 * CR-7 / task-36 真请求验证：超限 body 必须看到 HTTP 413 + JSON，而不是断连。
 *
 * 背景（task-34 实测，P0-2）：
 *   修前 MemoryCore/src/gateway/server.ts 的 parseJsonBody 在超限时
 *   `reject(new PayloadTooLargeError(...)); req.resume(); req.destroy()` —— socket
 *   在 413 写出前就被销毁，客户端只能看到 curl: (56) / TypeError: fetch failed，
 *   一个可诊断的 4xx 被降级成"网络故障"。
 *
 * 本脚本用**真 socket + 真 curl** 跑修前/修后两种实现，输出可直接贴进报告：
 *   - fixed ：直接复用 src/gateway/server.ts 导出的 parseJsonBody（修后代码）
 *   - legacy：内联复刻修前的 8 行（reject + resume + destroy），仅作对照
 * 两种实现挂在同一个响应壳上（413 + Connection: close + limitBytes/hint，与
 * gateway 顶层 catch 同形），因此差异只来自 parser 是否提前 destroy。
 *
 * 用法（MemoryCore 目录下）：
 *   node --import tsx scripts/verify-payload-limit-413.ts
 *
 * 纯本地回环，不连数据库、不碰线上资源。
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseJsonBody, PayloadTooLargeError } from "../src/gateway/server.js";
import { DEFAULT_MAX_BODY_BYTES } from "../src/utils/env-config.js";

const execFileAsync = promisify(execFile);

/** 修前 parseJsonBody 的超限分支（仅超限语义，其余等同修前实现）。 */
function parseJsonBodyLegacy<T>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const declared = Number.parseInt(req.headers["content-length"] ?? "", 10);
    if (Number.isFinite(declared) && declared > DEFAULT_MAX_BODY_BYTES) {
      reject(new PayloadTooLargeError(DEFAULT_MAX_BODY_BYTES));
      // ← 就是这两行把 413 吃掉：socket 先死，响应永远写不出去。
      req.resume();
      req.destroy();
      return;
    }
    const chunks: Buffer[] = [];
    let received = 0;
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > DEFAULT_MAX_BODY_BYTES) {
        reject(new PayloadTooLargeError(DEFAULT_MAX_BODY_BYTES));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")) as T);
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", () => {});
  });
}

function createServer(parser: <T>(req: http.IncomingMessage) => Promise<T>): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    try {
      const body = await parser<unknown>(req);
      const bytes = Buffer.byteLength(JSON.stringify(body ?? null));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, bytes }));
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        // 与 gateway 顶层 catch 同形（task-36 改动后）：先写 JSON 再关连接。
        // 与 sendJson 一致带 Content-Length，避免差异来自传输分帧。
        const json = JSON.stringify({
          error: err.message,
          code: 413,
          limitBytes: err.limitBytes,
          hint: "Split the batch into several smaller requests, or raise MEMORY_MAX_BODY_BYTES.",
          retryable: false,
        });
        res.setHeader("Connection", "close");
        res.writeHead(413, {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(json),
        });
        res.end(json);
        return;
      }
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function urlOf(server: http.Server): string {
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/upload`;
}

const dir = mkdtempSync(join(tmpdir(), "payload-limit-"));

/** 写一个 body 文件，返回 {path, bytes}。 */
function bodyFile(name: string, filler: string, repeat: number): { path: string; bytes: number } {
  const body = JSON.stringify({ blob: filler.repeat(repeat) });
  const path = join(dir, name);
  writeFileSync(path, body, "utf-8");
  return { path, bytes: Buffer.byteLength(body) };
}

/** 真 curl：返回 {exitCode, statusLine, body, stderr}。 */
async function curl(url: string, file: string): Promise<{
  exitCode: number; statusLine: string; body: string; stderr: string;
}> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "curl",
      // 关掉 curl 的 Expect: 100-continue，让输出里唯一的响应就是最终响应；
      // 真实客户端（undici，见 viaFetch）的 Expect 行为另行对照。
      ["-sS", "-i", "-X", "POST", "-H", "Expect:", "-H", "Content-Type: application/json", "--max-time", "30", "--data-binary", `@${file}`, url],
      { maxBuffer: 8 * 1024 * 1024, timeout: 30_000 },
    );
    const [head] = stdout.split("\r\n\r\n");
    const statusLine = head.split("\r\n")[0] ?? "";
    const body = stdout.split("\r\n\r\n").slice(1).join("");
    return { exitCode: 0, statusLine, body, stderr };
  } catch (err) {
    const e = err as { code?: number | string; stderr?: string };
    return { exitCode: typeof e.code === "number" ? e.code : -1, statusLine: "", body: "", stderr: (e.stderr ?? String(err)).trim() };
  }
}

/** 真 fetch（undici）对照：记录它看到什么。 */
async function viaFetch(url: string, body: string): Promise<string> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
    return `HTTP ${res.status} body=${(await res.text()).slice(0, 160)}`;
  } catch (err) {
    const e = err as { message?: string; cause?: { code?: string } };
    return `fetch failed: ${e.message} (cause=${e.cause?.code ?? "?"})`;
  }
}

async function main(): Promise<void> {
  const fixed = await createServer(parseJsonBody);
  const legacy = await createServer(parseJsonBodyLegacy);
  const cases = [
    { label: "0.9 MB（限制内·对照组）", file: bodyFile("ok-900k.json", "x", 900_000) },
    { label: "1.05 MB（略超限，task-34 现场）", file: bodyFile("over-1050k.json", "x", 1_050_000) },
    { label: "1.2 MB（超限 20%）", file: bodyFile("over-1200k.json", "x", 1_200_000) },
  ];

  console.log(`limit = ${DEFAULT_MAX_BODY_BYTES} bytes (MEMORY_MAX_BODY_BYTES 缺省)`);
  console.log(`curl = ${(await execFileAsync("curl", ["--version"]).then(r => r.stdout.split("\\n")[0]).catch(() => "unavailable"))}`);
  console.log("");

  for (const c of cases) {
    console.log(`=== ${c.label}，body ${c.file.bytes} bytes ===`);
    const legacyRes = await curl(urlOf(legacy), c.file.path);
    console.log(`legacy(修前): curl exit=${legacyRes.exitCode} status="${legacyRes.statusLine}" ${legacyRes.stderr ? `stderr=${legacyRes.stderr.split("\n")[0]}` : ""}`);
    const fixedRes = await curl(urlOf(fixed), c.file.path);
    console.log(`fixed (修后): curl exit=${fixedRes.exitCode} status="${fixedRes.statusLine}"`);
    if (fixedRes.body) console.log(`             body=${fixedRes.body.slice(0, 240)}`);
    console.log(`fetch  (修后): ${await viaFetch(urlOf(fixed), readFileSync(c.file.path, "utf-8"))}`);
    console.log("");
  }

  await new Promise<void>((resolve) => fixed.close(() => resolve()));
  await new Promise<void>((resolve) => legacy.close(() => resolve()));
}

await main();
