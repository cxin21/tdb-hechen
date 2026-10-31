/**
 * 离线 hash 向量（零外呼）——只用于**验证度量管线**，不是检索质量读数。
 *
 * 为什么需要它：
 *   - eval-memory-bench / gen-long-session-bench 的灌库与召回都依赖 embedding 服务；
 *     没有凭据的环境无法把「报告生成 → config.effective → 判分门禁 → 只追加」整条链路跑通；
 *   - 用真实凭据来验证管线既贵又会污染 embed-cache（缓存键按 model+dims 计）。
 *
 * 口径警告（写报告时**必须**同时声明）：
 *   - 这不是生产 embedding：字符/双字 n-gram FNV 哈希 + L2 归一，只保证「同一字面串可召回」；
 *   - 用它跑出的命中率**不可**与任何生产 embedding 读数并列，也不可写进结论性文档。
 *
 * 维度必须与沙箱库的 vec0 表一致（cfg.embedding.dimensions）。若维度不一致，sqlite 侧只会打
 * non-fatal 的 `Dimension mismatch` warn 并静默丢行 —— 表现为「召回全空 / 命中 0%」，
 * 而不是报错，这是本仓库踩过的真实坑（见 docs/long-session-bench.md §3 口径陷阱 2）。
 */

/**
 * @param {number} dims 向量维数（必须与库表维数一致；取 cfg.embedding.dimensions）
 * @returns {{embed:(t:string)=>Promise<Float32Array>, embedBatch:(ts:string[])=>Promise<Float32Array[]>, getDimensions:()=>number, getProviderInfo:()=>({provider:string,model:string,dimensions:number})}}
 */
export function makeOfflineEmbedding(dims) {
  const dim = dims && dims > 0 ? dims : 256;
  const vecOf = (text) => {
    const v = new Float32Array(dim);
    const t = String(text ?? "").toLowerCase();
    const tokens = t.match(/[a-z0-9]+|[\u4e00-\u9fff]{1,2}/g) || [];
    for (const tok of tokens) {
      let h = 2166136261;
      for (const ch of tok) {
        h ^= ch.codePointAt(0);
        h = Math.imul(h, 16777619);
      }
      v[(h >>> 0) % dim] += 1;
    }
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += v[i] * v[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dim; i++) v[i] /= norm;
    return v;
  };
  return {
    embed: async (text) => vecOf(text),
    embedBatch: async (texts) => (texts || []).map(vecOf),
    getDimensions: () => dim,
    getProviderInfo: () => ({ provider: "offline-hash", model: "offline-hash", dimensions: dim }),
  };
}

/** 报告里统一写这一条，防止「hash 向量读数」被当成生产读数列进文档。 */
export const OFFLINE_EMBEDDING_CALIBER =
  "offline-hash（字符/双字 n-gram 哈希，零外呼）：仅用于验证度量管线，不是生产 embedding，命中率不可作为检索质量结论";
