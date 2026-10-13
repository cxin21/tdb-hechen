/**
 * P1 task-3：真 worker_threads bootstrap 协议测试用的 transformers stub 模块。
 *
 * 刻意按行为验证 spike 实测的三条铁律（D:\TDB\data\spikes\reranker-spike\test-rerank-local.mjs）：
 * 1. env.allowLocalModels=true / env.allowRemoteModels=false / env.localModelPath=dirname(modelDir)
 *    —— 不满足即抛错（模拟真实库会走远端下载或找不到本地模型）。
 * 2. pair 编码必须 tokenizer(q,{text_pair:d,truncation:true}) —— 位置参数第二位会被吞；
 *    fixture 里 text_pair 缺失即抛错，保证 bootstrap 用对了编码方式。
 * 3. 模型输出取 out.logits.data[0]。
 * 打分规则：doc 含 "机器学习" → 2.5；"做菜" → 0.5；其余 -1。
 */
import fs from "node:fs";
import path from "node:path";

export const env = {};

function assertLocalEnv(modelId) {
  if (env.allowLocalModels !== true) throw new Error("fixture: env.allowLocalModels must be true");
  if (env.allowRemoteModels !== false) throw new Error("fixture: env.allowRemoteModels must be false");
  if (!env.localModelPath || !fs.existsSync(path.join(env.localModelPath, modelId, "config.json"))) {
    throw new Error(`fixture: env.localModelPath wrong: ${String(env.localModelPath)} for ${modelId}`);
  }
}

export const AutoTokenizer = {
  from_pretrained: async (modelId) => {
    if (modelId !== "bge-reranker-base") throw new Error(`fixture: unexpected modelId ${String(modelId)}`);
    assertLocalEnv(modelId);
    return (text, opts) => {
      if (!opts || opts.truncation !== true) throw new Error("fixture: truncation:true required");
      if (typeof opts.text_pair !== "string" || opts.text_pair.length === 0) {
        throw new Error("fixture: text_pair encoding required (positional pair arg is swallowed by transformers.js)");
      }
      return { inputs: { input_ids: [1, 2, 3] }, __d: opts.text_pair };
    };
  },
};

export const AutoModelForSequenceClassification = {
  from_pretrained: async (modelId, opts) => {
    assertLocalEnv(modelId);
    if (!opts || opts.dtype !== "q8") throw new Error("fixture: dtype:'q8' required");
    return async (inp) => {
      const d = String((inp && inp.__d) ?? "");
      const score = d.includes("机器学习") ? 2.5 : d.includes("做菜") ? 0.5 : -1;
      return { logits: { data: [score] } };
    };
  },
};

export default { env, AutoTokenizer, AutoModelForSequenceClassification };
