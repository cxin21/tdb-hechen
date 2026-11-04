/**
 * P1 召回质量（task-3）：rerank 专用 worker——transformers.js（onnxruntime-node）隔离在
 * worker_threads 内。协议（与 ../local.ts 的 RerankWorkerRequest/Response 对应）：
 * - 父→worker：{type:"load",modelDir} / {type:"score",id,query,docs}
 * - worker→父：{type:"loaded"} / {type:"scores",id,scores} / {type:"error",id,message}
 *   （load 级失败 id=null；score 级失败 id=请求 id，worker 可继续服务）
 *
 * spike 铁律（D:\TDB\data\spikes\reranker-spike\test-rerank-local.mjs 实测结论）：
 * - env.allowLocalModels=true / env.allowRemoteModels=false / env.localModelPath=包含
 *   <org>/<model> 的根目录；modelId=basename(modelDir)。
 * - pair 编码必须 tokenizer(q,{text_pair:d,truncation:true})——位置参数第二位会被吞。
 * - 输出取 out.logits.data[0]。
 * - 绝不使用 transformers.js 内建下载器（hf-mirror 429 实锤）——下载由 downloader.ts 负责，
 *   worker 只做本地加载。
 */
import path from "node:path";
import { parentPort } from "node:worker_threads";

// 推理参数（2026-11-04 实测标定，缺省即最优点，零配置）：
// - intra_op_num_threads：实测 1/2/4/8 线程 = 3257/1939/3245/3850ms（32 候选 × 400 字符），2 是唯一收益档。
// - docCap：耗时随「候选数 × 文档前缀长度」线性增长，1200 字符以上撞 tokenizer 512-token 截断后不再增长；
//   生产 L1 行 p50=497 字符（bench 库 1591 条实测），截到 320 字符 → ≈1.6s。
// 下发优先级：workerData.tuning（./tuning.ts 单点定义）> 环境变量（仅 A/B 复现用）> 内置缺省。
const { workerData } = await import("node:worker_threads"); // 必须先于下方常量（TDZ）

const ENV_THREADS = Number(process.env.RERANK_THREADS ?? "0") || 0;
const ENV_DOC_CAP = Number(process.env.RERANK_DOC_CAP ?? "0") || 0;
const RERANK_THREADS = Number(workerData?.tuning?.threads ?? "0") || ENV_THREADS || 2;
const RERANK_DOC_CAP = Number(workerData?.tuning?.docCap ?? "0") || ENV_DOC_CAP || 320;

const modelLib = workerData?.transformersEntryUrl
  ? await import(workerData.transformersEntryUrl)
  : await import("@huggingface/transformers");

let tokenizer = null;
let model = null;

parentPort.on("message", async (msg) => {
  if (!msg || typeof msg !== "object") return;
  try {
    if (msg.type === "load") {
      const modelDir = msg.modelDir ?? workerData?.modelDir ?? "";
      if (!modelDir) throw new Error("load: modelDir missing");
      modelLib.env.allowLocalModels = true;
      modelLib.env.allowRemoteModels = false;
      modelLib.env.localModelPath = path.dirname(modelDir);
      const modelId = path.basename(modelDir);
      tokenizer = await modelLib.AutoTokenizer.from_pretrained(modelId);
      model = await modelLib.AutoModelForSequenceClassification.from_pretrained(modelId, {
        dtype: "q8",
        ...(RERANK_THREADS > 0
          ? { session_options: { intra_op_num_threads: RERANK_THREADS } }
          : {}), // 缺省 2（实测最优）；0 只用 env 显式关闭时才可能出现
      });
      parentPort.postMessage({ type: "loaded" });
      return;
    }
    if (msg.type === "score") {
      if (!tokenizer || !model) throw new Error("score before load");
      const scores = [];
      for (const raw of msg.docs) {
        const doc =
          RERANK_DOC_CAP > 0 && raw.length > RERANK_DOC_CAP
            ? raw.slice(0, RERANK_DOC_CAP)
            : raw;
        const inputs = await tokenizer(msg.query, { text_pair: doc, truncation: true });
        const out = await model(inputs);
        scores.push(out.logits.data[0]);
      }
      parentPort.postMessage({ type: "scores", id: msg.id, scores });
      return;
    }
  } catch (err) {
    const id = msg.type === "score" ? msg.id : null;
    parentPort.postMessage({
      type: "error",
      id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
});
