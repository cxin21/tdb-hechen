/**
 * B0 校尺修复（bench/recall-opt）：bench 侧精排子进程。
 * onnxruntime-node 在 bench 进程内的 worker_threads 里会原生崩溃（exit 127 = ACCESS_VIOLATION，
 * 2026-10-27 二分实锤：--rerank-off 6 题完整 / 默认 6 题 1 次 rerank null 后死），Windows 上一颗
 * worker 崩带走整进程。子进程隔离：崩了父进程拿到非零退出 → 返回 null（降级原序）→ 下次重拉。
 * 协议（stdin/stdout 每行一个 JSON）：{id,query,docs} → {id,ok,scores?}，scores 已按分降序。
 * 启动参数：node rerank-child.mjs <modelDir> [idleUnloadMs]
 */
import fs from "node:fs";
import { createReranker } from "../../../src/core/recall/rerank/factory.ts";

const [, , modelDir, idleArg] = process.argv;
const cfg = {
  enabled: true,
  provider: "local",
  local: { modelDir: modelDir, ...(idleArg ? { idleUnloadMs: Number(idleArg) } : {}) },
};
const reranker = createReranker(cfg);
if (!reranker) {
  process.stderr.write("rerank-child: createReranker returned null\n");
  process.exit(2);
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) {
      outstanding++;
      void handle(line).finally(() => {
        outstanding--;
        maybeExit();
      });
    }
  }
});
let stdinEnded = false;
let outstanding = 0;
function maybeExit() {
  if (stdinEnded && outstanding === 0) process.exit(0);
}
process.stdin.on("end", () => {
  stdinEnded = true;
  maybeExit(); // 文件重定向/管道关闭后：排空在途请求再退，不能提前自杀
});

async function handle(line) {
  let id = null;
  try {
    const msg = JSON.parse(line);
    id = msg.id;
    const ranked = await reranker.rerank(String(msg.query ?? ""), Array.isArray(msg.docs) ? msg.docs.map(String) : []);
    write({ id, ok: true, scores: ranked });
  } catch (err) {
    write({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

function write(obj) {
  fs.writeSync(1, JSON.stringify(obj) + "\n"); // 同步写：exit 前必须落盘，异步 stdout 会被吞
}