#!/usr/bin/env node
/**
 * config key consumption audit (task-107) — 机器产出、零硬编码结论。
 *
 * 1. 从 src/config-schema.ts 的 VOLATILE_PATHS / SECRET_PATHS 抽出「设置页可见键」；
 * 2. 从 src/config.ts 的 DEFAULT_CONFIG 字面量结构解析出「配置面全集叶子」（不 eval）；
 * 3. 扫 src 下所有 .ts，对每个键找两类读点：
 *      强证据 = 完整点路径（config.server.baseUrl / config.volatile.soul.maxChars）；
 *      弱证据 = 属性访问（x.leaf）或解构（{ leaf }），接口声明行不算；
 * 4. 三档判定（可复跑，不是人肉结论）：
 *      effective    在 config.ts / config-schema.ts 之外被读 ⇒ 有消费点；
 *      needs-review 只有弱证据（解构/间接取值），脚本不定档，交人判；
 *      parse-only   只在 config.ts（归一化）里出现 ⇒ 读进来没人用；
 *      orphan       src 里除声明外零引用；
 * 5. 反向清单：DEFAULT_CONFIG 有、但不在 VOLATILE_PATHS ∪ SECRET_PATHS 的叶子
 *    —— 设置页看不见却影响行为的旋钮。
 *
 * 用法：node dsh-plugin/scripts/audit-config-keys.mjs [--json] [--strict]
 *   --strict 有 orphan 则 exit 1。静态扫源码：不执行插件、不联网、不碰 ~/.dsh。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SRC = path.join(ROOT, "src");
const SCHEMA_FILE = path.join(SRC, "config-schema.ts");
const CONFIG_FILE = path.join(SRC, "config.ts");
const DECL_FILES = new Set(["config-schema.ts", "config.ts"]);

const args = new Set(process.argv.slice(2));
const AS_JSON = args.has("--json");
const STRICT = args.has("--strict");

/** 去注释但保留字符串内容（baseUrl 里的 // 不能被吃掉）。 */
function stripComments(text) {
  let out = "";
  let i = 0;
  let quote = null;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") { out += text[i + 1] ?? ""; i += 2; continue; }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") { quote = c; out += c; i += 1; continue; }
    if (c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") i += 1; continue; }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

const readTs = (file) => stripComments(fs.readFileSync(file, "utf8"));

function stringArrayConst(source, name) {
  const re = new RegExp("export const " + name + "\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const;", "m");
  const m = source.match(re);
  if (!m) throw new Error("missing const " + name);
  return [...m[1].matchAll(/['\"]([^'\"]+)['\"]/g)].map((x) => x[1]);
}

/** DEFAULT_CONFIG 字面量 -> 叶子路径（花括号结构解析，不执行源码）。 */
function defaultConfigLeaves(source) {
  const start = source.indexOf("export const DEFAULT_CONFIG");
  if (start < 0) throw new Error("missing DEFAULT_CONFIG");
  const lines = source.slice(start).split(/\r?\n/).slice(1);
  const stack = [];
  const leaves = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("}")) {
      stack.pop();
      if (line.startsWith("};")) break;
      continue;
    }
    const open = line.match(/^([A-Za-z_$][\w$]*)\s*:\s*\{/);
    if (open) { stack.push(open[1]); continue; }
    const leaf = line.match(/^([A-Za-z_$][\w$]*)\s*:/);
    if (leaf) leaves.push([...stack, leaf[1]].join("."));
  }
  return leaves;
}

function walkTs(dir, acc = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkTs(p, acc);
    else if (ent.name.endsWith(".ts")) acc.push(p);
  }
  return acc;
}

const VOLATILE = stringArrayConst(readTs(SCHEMA_FILE), "VOLATILE_PATHS");
const SECRETS = stringArrayConst(readTs(SCHEMA_FILE), "SECRET_PATHS");
const leaves = defaultConfigLeaves(readTs(CONFIG_FILE));

const files = walkTs(SRC).map((p) => ({
  rel: path.relative(ROOT, p).replace(/\\/g, "/"),
  base: path.basename(p),
  lines: fs.readFileSync(p, "utf8").split(/\r?\n/),
}));

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const dotPathRe = (key) => {
  // 多段键允许前面紧跟 dot（config.server.baseUrl 的尾巴也是有效读点）；
  // 单段键（enabled/debug）必须不是属性尾，否则 logger.debug 会冒充整棵配置。
  const head = key.includes(".") ? "(^|[^\\w$])" : "(^|[^\\w$.])";
  return new RegExp(head + key.split(".").map(escapeRe).join("\\.") + "\\b");
};
const leafUseRe = (leaf) => new RegExp("(\\." + escapeRe(leaf) + "\\b|[{,]\\s*" + escapeRe(leaf) + "\\s*[,}])");
/** 接口/类型声明行不是消费证据（形状 != 读用）。 */
const isTypeDeclLine = (code) =>
  /^[}]*\s*(readonly\s+)?[A-Za-z_$][\w$]*\??:\s*(boolean|string|number)\s*;?\s*$/.test(code) ||
  /^(export\s+)?(interface|type)\s/.test(code);

function findHits(key) {
  const fullRe = dotPathRe(key);
  const leafRe = leafUseRe(key.split(".").pop());
  const strong = [];
  const weak = [];
  for (const f of files) {
    if (f.base === "config-schema.ts") continue;
    f.lines.forEach((text, idx) => {
      const code = text.trim();
      if (!code || code.startsWith("*") || code.startsWith("//")) return;
      if (isTypeDeclLine(code)) return;
      const decl = DECL_FILES.has(f.base);
      if (fullRe.test(text)) strong.push({ file: f.rel, line: idx + 1, code, decl });
      else if (leafRe.test(text)) weak.push({ file: f.rel, line: idx + 1, code, decl });
    });
  }
  return { strong, weak };
}

function classify(key) {
  const { strong, weak } = findHits(key);
  const sOut = strong.filter((h) => !h.decl);
  const sDecl = strong.filter((h) => h.decl);
  const wOut = weak.filter((h) => !h.decl);
  const wDecl = weak.filter((h) => h.decl);
  let verdict;
  if (sOut.length) verdict = "effective";
  else if (wOut.length) verdict = "needs-review";
  else if (sDecl.length || wDecl.length) verdict = "parse-only";
  else verdict = "orphan";
  return { key, verdict, strong, weak, sOut, sDecl, wOut, wDecl };
}

const visible = [...VOLATILE, ...SECRETS];
const rows = VOLATILE.map(classify);
const secretRows = SECRETS.map(classify);
const hidden = leaves.filter((l) => !visible.includes(l)).map(classify);

const fmt = (h) => h.file + ":" + h.line + "  " + h.code.slice(0, 92);
const fmtEv = (r) => {
  const ev = r.sOut[0] || r.wOut[0] || r.sDecl[0] || r.wDecl[0];
  return ev ? fmt(ev) : "无";
};

if (AS_JSON) {
  console.log(JSON.stringify({ volatile: rows, secrets: secretRows, hidden, leaves: leaves.length }, null, 1));
} else {
  const list = (v) => rows.filter((r) => r.verdict === v).map((r) => r.key).join(", ") || "—";
  console.log("# 设置页可见键（VOLATILE_PATHS " + VOLATILE.length + " + SECRET_PATHS " + SECRETS.length + "）\n");
  console.log("| # | key | 档位 | 首条证据 | 强/弱 |");
  console.log("| --- | --- | --- | --- | --- |");
  rows.forEach((r, i) => {
    console.log("| " + (i + 1) + " | " + r.key + " | " + r.verdict + " | " + fmtEv(r) + " | " + r.strong.length + "/" + r.weak.length + " |");
  });
  console.log("\n## 密钥（表单不渲染，只改 ref）\n");
  for (const r of secretRows) console.log("- " + r.key + " -> " + r.verdict + "  " + fmtEv(r));
  console.log("\n## 汇总\n");
  console.log("- 生效(effective): " + list("effective"));
  console.log("- 待人工判定(needs-review): " + list("needs-review"));
  console.log("- 仅解析(parse-only): " + list("parse-only"));
  console.log("- 孤儿(orphan): " + list("orphan"));
  console.log("\n## 反向清单：DEFAULT_CONFIG 有、设置页看不见（" + hidden.length + " 条）\n");
  console.log("| key | 档位 | 首条证据 |");
  console.log("| --- | --- | --- |");
  for (const r of hidden) console.log("| " + r.key + " | " + r.verdict + " | " + fmtEv(r) + " |");
  console.log("\n叶子总数 " + leaves.length + "，可见 " + visible.length + "，隐藏 " + hidden.length);
}

const orphans = rows.filter((r) => r.verdict === "orphan");
if (STRICT && orphans.length) {
  console.error("[strict] 孤儿键 " + orphans.length + " 个: " + orphans.map((r) => r.key).join(", "));
  process.exit(1);
}