#!/usr/bin/env node
/**
 * check-config-consistency.mjs —— 三方一致性检查（tencent 云模板 / global-images base / 代码缺省）
 *
 * 背景（#172-③、"缺省=生产最优档" 原则）：
 *   仓库里同一套 memory.* 决策值有三处落点：
 *     1) deploy/tencent-cloud/config/core/tdai-gateway.cloud.yaml  （腾讯云生产契约）
 *     2) deploy/global-images/tdai-gateway.base.yaml               （global-images 生产基础档，脚本渲染源）
 *     3) MemoryCore/src/config.ts 的 ?? 缺省                        （零配置用户 / 无 yaml 时的行为）
 *   "改了云模板不代表线上变了"，反之亦然。本脚本机械地对 1) 与 2) 做逐键比对，
 *   并对 3) 里"已被 yaml 显式钉住"的键做一次期望值核对（EXPECTED_CODE_DEFAULTS）。
 *   三方彻底对齐做不到全自动：代码缺省藏在 ???/三元/常量里，只能人工补进本表。
 *
 * 用法：
 *   node deploy/global-images/check-config-consistency.mjs           # 人读输出，不一致 exit 1
 *   node deploy/global-images/check-config-consistency.mjs --quiet   # 只打结论行
 *
 * 允许差异白名单（部署环境差异，非漂移）：见 ALLOWED_DIFF。
 * 新增白名单项必须在 docs/ops/production-profile.md 有对应行，否则下一个人会当漂移删掉。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");

/** 从 MemoryCore/node_modules 解析 yaml（deploy 目录无自己的依赖，避免为了一个解析器装包） */
function loadYaml() {
  const req = createRequire(path.join(REPO, "MemoryCore", "noop.js"));
  try {
    return req("yaml");
  } catch {
    try {
      return req("js-yaml");
    } catch {
      console.error("[config-consistency] 找不到 yaml 解析器：需要 MemoryCore/node_modules 已安装（pnpm install）。");
      process.exit(2);
    }
  }
}

const FILES = {
  base: path.join(REPO, "deploy/global-images/tdai-gateway.base.yaml"),
  cloud: path.join(REPO, "deploy/tencent-cloud/config/core/tdai-gateway.cloud.yaml"),
};

/** 白名单：部署环境差异（占位符 / 端点 / 模型 / 超时预算），不是决策漂移 */
const ALLOWED_DIFF = new Set([
  "llm.baseUrl",
  "llm.apiKey",
  "llm.model",
  "llm.maxTokens", // base 渲染期由 env 决定，云模板钉 4096
  "llm.timeoutMs", // base 300000（长会话），云 120000
  "memory.promptMode", // 渲染期由 MEMORY_PROMPT_MODE 决定
  "memory.embedding.provider",
  "memory.embedding.baseUrl",
  "memory.embedding.apiKey",
  "memory.embedding.model",
  "memory.embedding.dimensions",
  "memory.storeBackend", // 云 tcvdb / 单机 sqlite（deployMode 差异）
  "deployMode",
  "stateBackend",
  "server.apiKey", // 环境注入
  "data.baseDir",
]);

/**
 * 期望的代码缺省（MemoryCore/src/config.ts 解析处，人工维护）。
 * 这里只列"yaml 已经显式钉住、且钉值必须与代码缺省同源"的键 —— 也就是防漂移钉子。
 * value 写的是"两套 yaml 应同时等于"的值；为什么不自动读 config.ts：缺省藏在
 * num() ?? x / 三元 / 常量里，静态抓取不可靠，抓错了比不抓更危险。
 * 每条附解析点，改代码缺省时本表与两套 yaml 必须同改（三方一致检查会红）。
 */
const EXPECTED_CODE_DEFAULTS = [
  { key: "memory.recall.maxResults", value: 10, at: "src/config.ts:2138 (?? 10)" },
  { key: "memory.recall.validity.mode", value: "soft", at: "src/config.ts:2241 (#136 软失效，未知值也落 soft)" },
  { key: "memory.recall.validity.softPenalty", value: 0.5, at: "core/recall/validity-policy.ts resolveSoftValidityPenalty 缺省 0.5" },
  { key: "memory.recall.injectWrapper", value: "calibrated", at: "src/config.ts:2291 → core/recall/inject-wrapper.ts INJECT_WRAPPER_DEFAULT" },
  { key: "memory.recall.rerank.mode", value: "rerank", at: "src/config.ts:2497 (str==='filter' ? filter : rerank)" },
  { key: "memory.recall.rerank.candidates", value: 32, at: "DEFAULT_RERANK_CANDIDATES 缺省 32（防漂移钉）" },
  { key: "memory.recall.fusion.mode", value: "rrf", at: "src/config.ts:161 类型注释 / fusion 解析缺省 rrf" },
  { key: "memory.recall.presentTemporal.enabled", value: false, at: "src/config.ts:2150-2158" },
  { key: "memory.recall.evidencePack.enabled", value: false, at: "src/config.ts:2293 起（归口 #169）" },
];

function flat(obj, prefix = "", out = {}) {
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    for (const k of Object.keys(obj)) flat(obj[k], prefix ? prefix + "." + k : k, out);
  } else {
    out[prefix] = obj;
  }
  return out;
}

const yaml = loadYaml();
const parse = (f) => (yaml.parse ? yaml.parse(fs.readFileSync(f, "utf8")) : yaml.load(fs.readFileSync(f, "utf8")));

let failed = 0;
const say = (s) => console.log(s);

const flatBase = flat(parse(FILES.base));
const flatCloud = flat(parse(FILES.cloud));

// memory.* 决策键前缀；其它顶层段（server/llm/data/deployMode）按白名单处理
const DECISION_PREFIXES = ["memory.", "skill.", "agent.", "offload."];
const isDecision = (k) => DECISION_PREFIXES.some((p) => k.startsWith(p));

const onlyBase = Object.keys(flatBase).filter((k) => !(k in flatCloud) && !ALLOWED_DIFF.has(k));
const onlyCloud = Object.keys(flatCloud).filter((k) => !(k in flatBase) && !ALLOWED_DIFF.has(k));
const valueDiff = Object.keys(flatBase)
  .filter((k) => k in flatCloud && !ALLOWED_DIFF.has(k) && JSON.stringify(flatBase[k]) !== JSON.stringify(flatCloud[k]))
  .map((k) => ({ key: k, base: flatBase[k], cloud: flatCloud[k] }));

say("=== 1) 云模板 vs global-images base（机械逐叶比对，白名单外必须零差异）===");
if (!onlyBase.length && !onlyCloud.length && !valueDiff.length) {
  say("  OK：白名单外键集合与值完全一致。");
} else {
  failed++;
  for (const k of onlyBase) say("  ONLY_BASE  " + k + " = " + JSON.stringify(flatBase[k]) + "（云模板缺这个键）");
  for (const k of onlyCloud) say("  ONLY_CLOUD " + k + " = " + JSON.stringify(flatCloud[k]) + "（base 缺这个键）");
  for (const d of valueDiff) say("  DIFF       " + d.key + "：base=" + JSON.stringify(d.base) + " cloud=" + JSON.stringify(d.cloud));
}

say("=== 2) 两套 yaml vs 代码缺省（EXPECTED_CODE_DEFAULTS 人工表，防漂移钉）===");
for (const e of EXPECTED_CODE_DEFAULTS) {
  const b = flatBase[e.key];
  const c = flatCloud[e.key];
  const ok = JSON.stringify(b) === JSON.stringify(e.value) && JSON.stringify(c) === JSON.stringify(e.value);
  if (!ok) {
    failed++;
    say("  MISMATCH " + e.key + "：期望(代码缺省)=" + JSON.stringify(e.value) + " base=" + JSON.stringify(b) + " cloud=" + JSON.stringify(c) + "  ← " + e.at);
  }
}
if (!failed) say("  OK：" + EXPECTED_CODE_DEFAULTS.length + " 个防漂移钉两套 yaml 均等于代码缺省。");

say("=== 3) 未进 EXPECTED_CODE_DEFAULTS、需人工复核的键（改动时人工对比 config.ts）===");
const decisionKeys = Object.keys(flatCloud).filter(isDecision).sort();
say("  memory.*/skill.* 决策叶键共 " + decisionKeys.length + " 个；自动核对的 " + EXPECTED_CODE_DEFAULTS.length +
    " 个，其余 " + (decisionKeys.length - EXPECTED_CODE_DEFAULTS.length) + " 个依赖行内注释与 docs/ops/production-profile.md。");
say("  复查命令：grep -nE 'maxResults|validity|injectWrapper|rerank|candidateK|fusion|presentTemporal|evidencePack' MemoryCore/src/config.ts");

if (failed) {
  say("[config-consistency] FAIL：存在白名单外差异或防漂移钉失配（" + failed + " 组）。改哪一处都要三处同改。");
  process.exit(1);
}
say("[config-consistency] PASS：两套 yaml 一致，防漂移钉与代码缺省同值。");
