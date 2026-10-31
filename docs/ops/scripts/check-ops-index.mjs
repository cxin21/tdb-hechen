#!/usr/bin/env node
// docs/ops 索引检查：README.md 是全目录索引，新增文档必须进索引，且索引行必须指向真文件。
//
// 为什么要有它：docs/ops 里已有 60+ 份文档，靠人肉记得「新增时要同步改索引」不可靠——
// 上一轮就出现过 9 份文档进了目录、README 里没有一行（task-105）。
//
// 用法：
//   node docs/ops/scripts/check-ops-index.mjs                 # 默认查 docs/ops
//   node docs/ops/scripts/check-ops-index.mjs --quiet         # 只出错时才说话（给 CI/门禁用）
//   node docs/ops/scripts/check-ops-index.mjs --json          # 机器可读
//   node docs/ops/scripts/check-ops-index.mjs --readme <p>    # 用另一次版本的 README 做假绿/假红演练
//
// 退出码：0 索引齐全；1 有未索引文档或悬空索引行；2 参数/环境问题（目录或 README 不存在）。

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = resolve(HERE, "..");                 // docs/ops
const INDEX_NAME = "README.md";

function parseArgs(argv) {
  const opts = { dir: DEFAULT_DIR, readme: null, json: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") { opts.help = true; continue; }
    if (a === "--json") { opts.json = true; continue; }
    if (a === "--quiet") { opts.quiet = true; continue; }
    if (a === "--dir") { opts.dir = resolve(argv[++i] ?? ""); continue; }
    if (a === "--readme") { opts.readme = resolve(argv[++i] ?? ""); continue; }
    throw new Error("未知参数: " + a);
  }
  return opts;
}

// 索引行形如： | [name.md](name.md) | 作用 | ... |
// 只认「表格单元里的 markdown 链接」，正文里随口提到的文件名不算已索引。
const LINK_RE = /\[[^\]]*\]\(([A-Za-z0-9._\-\/]+\.md)\)/g;

function linksIn(markdown) {
  const out = new Set();
  for (const rawLine of markdown.split(/\r?\n/)) {
    // 先剥 HTML 注释：整行被 <!-- ... --> 注释掉时，那一行不再算「已索引」
    const line = rawLine.replace(/<!--[\s\S]*?-->/g, "").trim();
    if (!line.startsWith("|")) continue;                  // 只扫表格行
    for (const m of line.matchAll(LINK_RE)) out.add(m[1]);
  }
  return out;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error("[ops-index] " + e.message);
    return 2;
  }
  if (opts.help) {
    console.log("用法: node docs/ops/scripts/check-ops-index.mjs [--dir <docs/ops>] [--readme <README.md>] [--quiet] [--json]");
    return 0;
  }
  if (!existsSync(opts.dir)) { console.error("[ops-index] 目录不存在: " + opts.dir); return 2; }
  const readme = opts.readme ?? join(opts.dir, INDEX_NAME);
  if (!existsSync(readme)) { console.error("[ops-index] 索引文件不存在: " + readme); return 2; }

  const docs = readdirSync(opts.dir)
    .filter((f) => f.endsWith(".md") && f !== INDEX_NAME)
    .sort();
  const indexed = linksIn(readFileSync(readme, "utf8"));

  const unindexed = docs.filter((f) => !indexed.has(f));
  // 反向：索引指向的 .md 在目录里不存在（改名/删除后残留的悬空行）
  const dangling = [...indexed].filter((f) => !f.includes("/") && !existsSync(join(opts.dir, f))).sort();
  const reserved = [...indexed].filter((f) => f.includes("/"));   // 交叉引用不算本目录文档

  const ok = unindexed.length === 0 && dangling.length === 0;
  if (opts.json) {
    console.log(JSON.stringify({ ok, dir: opts.dir, readme, docs: docs.length, indexed: indexed.size, unindexed, dangling, crossRefs: reserved }, null, 2));
    return ok ? 0 : 1;
  }
  if (!opts.quiet) {
    console.log("[ops-index] 索引: " + readme);
    console.log("[ops-index] 目录内文档 " + docs.length + " 份，索引链接 " + indexed.size + " 条（含跨目录引用 " + reserved.length + " 条）");
  }
  if (unindexed.length) {
    console.error("[ops-index] 未进索引（" + unindexed.length + " 份）——请在 " + INDEX_NAME + " 对应分组补一行「回答什么问题」：");
    for (const f of unindexed) console.error("  - " + f);
  }
  if (dangling.length) {
    console.error("[ops-index] 悬空索引行（" + dangling.length + " 条）——文件已不存在，删行或改指向：");
    for (const f of dangling) console.error("  - " + f);
  }
  if (ok && !opts.quiet) console.log("[ops-index] OK：目录内每份文档都有索引行，且没有悬空链接");
  return ok ? 0 : 1;
}

process.exit(main());
