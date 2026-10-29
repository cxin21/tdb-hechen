/**
 * bench 缓存三件套合一（issue #139 第3项）。
 *
 * 背景：facts / conclusions / embed 三处缓存各写一套 path/read/save，原子写纪律不一
 * （embed 失败静默、facts/conclusions 用 file+'.tmp' 固定名——并发写会互踩）。
 *
 * 契约（本模块是唯一实现）：
 *  - 路径：<baseDir>/<kind>/<sanitize(caseId)>.json；
 *  - 读：文件缺失/JSON 坏/校验不过 → null（绝不抛）；
 *  - 写：mkdir -p + 同目录临时名（含 pid/随机/计数器）+ rename 原子落盘；
 *  - 校验函数由调用方给（facts 校 promptVersion，conclusions 还校 model/maxCards）。
 */

import fs from "node:fs";
import path from "node:path";

let tmpSeq = 0;

/** caseId → 安全文件名（历史规则不变：非 \w.- 一律 '_'）。 */
export function sanitizeCaseId(caseId) {
  return String(caseId ?? "").replace(/[^\w.-]+/g, "_");
}

/** <baseDir>/<kind>。 */
export function cacheDirOf(baseDir, kind) {
  if (!baseDir) throw new Error("cacheDirOf: baseDir 必填");
  if (!kind) throw new Error("cacheDirOf: kind 必填");
  return path.join(baseDir, kind);
}

/** <baseDir>/<kind>/<sanitized>.json。 */
export function cacheFileOf(baseDir, kind, caseId) {
  return path.join(cacheDirOf(baseDir, kind), sanitizeCaseId(caseId) + ".json");
}

/**
 * 读缓存。返回 {payload, file} 或 null。
 * @param {string} baseDir
 * @param {string} kind
 * @param {string} caseId
 * @param {(payload:any)=>(boolean|{ok:boolean,reason?:string})} [validate]
 * @param {(err:Error, file:string)=>void} [onError]
 */
export function readCache(baseDir, kind, caseId, validate, onError, onInvalid) {
  const file = cacheFileOf(baseDir, kind, caseId);
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    onError?.(err, file);
    return null;
  }
  if (validate) {
    let verdict;
    try {
      verdict = validate(payload);
    } catch (err) {
      onError?.(err, file);
      return null;
    }
    const ok = typeof verdict === "object" && verdict !== null ? verdict.ok : verdict;
    if (!ok) {
      // 校验不过 = 缓存失效（模型/promptVersion 变更）→ 会静默重抽；把原因交出去，
      // 否则「重抽无 log 无计数」让人误以为命中了缓存（Spec 评审建议修 3）。
      const reason = typeof verdict === "object" && verdict !== null ? verdict.reason : undefined;
      onInvalid?.(reason, file);
      return null;
    }
  }
  return { payload, file };
}

/**
 * 原子写缓存。任何异常都抛给调用方（写失败是安静的数据腐化源头，不再静默吞）。
 * @returns {string} 写入的文件路径
 */
export function writeCache(baseDir, kind, caseId, payload) {
  const dir = cacheDirOf(baseDir, kind);
  const file = cacheFileOf(baseDir, kind, caseId);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + ".tmp-" + process.pid + "-" + (tmpSeq++).toString(36);
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload), "utf8");
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 清理失败不掩盖原始错误 */
    }
    throw err;
  }
  return file;
}

/** 缓存目录是否存在（--facts-only 等场景的空目录诊断用）。 */
export function cacheDirExists(baseDir, kind) {
  try {
    return fs.statSync(cacheDirOf(baseDir, kind)).isDirectory();
  } catch {
    return false;
  }
}
