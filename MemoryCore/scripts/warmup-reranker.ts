/**
 * #63（2026-10-18）：local rerank 模型预热脚本（开门前置，离线跑一次）。
 *
 * 痛点：provider:"local" 的模型文件（Xenova/bge-reranker-base，~113MB）缺省在首次
 * rerank 调用时 fire-and-forget 下载（downloader 双源自管 hf-mirror/ModelScope）——
 * 直接开生产门会把首次召回拖进分钟级下载。本脚本在部署后、开门前离线跑一次，
 * 把「下载 + worker 加载 + 首次推理」全部提前完成，开门即热。
 *
 * 用法：node --import tsx scripts/warmup-reranker.ts <dataDir>
 *   生产：node --import tsx scripts/warmup-reranker.ts /data/tdai-memory
 *   modelDir 固定推导 = <dataDir>/models/reranker/Xenova/bge-reranker-base
 *           （与 config.local.modelDir 缺省 resolveLocalModelDir 同式）。
 *
 * 步骤：isRerankModelReady 快查 → startRerankModelDownload（幂等：已 ready 零网络）→
 *       LocalReranker 首跑 rerank dummy（spawn worker + transformers.js 加载 + 1 次推理）
 *       → 分段耗时输出 → dispose。退出码 0=预热成功（后续 recall 首跑即热）。
 */
import path from "node:path";
import {
  startRerankModelDownload,
  isRerankModelReady,
  getRerankModelStatus,
} from "../src/core/recall/rerank/downloader.js";
import { LocalReranker } from "../src/core/recall/rerank/local.js";

const dataDir = process.argv[2] ?? process.env.TDAI_DATA_DIR ?? "";
if (!dataDir) {
  console.error("[warmup-reranker] 缺 dataDir：argv[2]=<dataDir>（生产 /data/tdai-memory）或 TDAI_DATA_DIR");
  process.exit(2);
}
const modelDir = path.join(dataDir, "models", "reranker", "Xenova", "bge-reranker-base");
console.log("[warmup-reranker] modelDir:", modelDir);

const tAll = Date.now();
if (isRerankModelReady(modelDir)) {
  console.log("[warmup-reranker] 模型文件已就绪，跳过下载");
} else {
  const tDl = Date.now();
  console.log("[warmup-reranker] 开始下载（双源自管，主 hf-mirror / 备 ModelScope）…");
  const ok = await startRerankModelDownload({ modelDir });
  if (!ok) {
    console.error("[warmup-reranker] 下载失败：", JSON.stringify(getRerankModelStatus()));
    process.exit(1);
  }
  console.log("[warmup-reranker] 下载完成，耗时", Date.now() - tDl, "ms");
}

const tLoad = Date.now();
const reranker = new LocalReranker({ modelDir, idleUnloadMs: 0 });
try {
  const scores = await reranker.rerank("预热探针查询：系统部署与根因排查", [
    "部署根因排查：先定位根因再动手，拒绝临时补丁。",
    "今天天气不错，适合散步。",
    "发布前必须跑全量测试确认没有回归。",
  ]);
  if (!scores || scores.length === 0) {
    console.error("[warmup-reranker] 预热推理返回空/null（worker 加载失败？查上方错误）");
    process.exit(1);
  }
  console.log("[warmup-reranker] 首跑推理成功：加载+加载后首推理", Date.now() - tLoad, "ms");
  console.log("[warmup-reranker] scores:", JSON.stringify(scores));
  console.log("[warmup-reranker] 预热总耗时", Date.now() - tAll, "ms —— 开门即热");
  process.exit(0);
} finally {
  void reranker.dispose().catch(() => undefined);
}
