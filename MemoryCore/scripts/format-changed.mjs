#!/usr/bin/env node
/**
 * format-changed.mjs —— MemoryCore 的「只对改动文件」格式门禁（#108）。
 *
 * 为什么不跑整仓：2026-10-31 实测，MemoryCore/src 下 646 个 .ts 里，prettier 3.9.10
 * 在**任何**参数组合下都有 >545 个文件与现状不一致（缺省 600、Panel 口径 640、
 * printWidth 120 最优 547）。也就是说本仓从未跑过 prettier，一次性 reformat 会产出
 * 一个 600 文件的纯噪声 diff（#108 票面也要求格式变更必须独立 commit、不与功能改动同 PR）。
 *
 * 所以门禁分两档，避免「刚开闸就让所有在飞 PR 变红」：
 *   - **新增文件（git diff --diff-filter=A）硬门**：新代码必须生而合规 —— 这一条从第一天就能执行，
 *     不需要动任何存量文件。
 *   - **改动到的存量文件告警**（默认不 exit 1）：它们是存量 >545 不一致的一部分，
 *     要 .prettierrc 落地后另开一个「纯格式 commit」统一刷；该 commit 合入后把
 *     FORMAT_STRICT_MODIFIED=1 打开，第二档转硬门。
 *
 * 用法：
 *   node scripts/format-changed.mjs              # 检查（CI 用；新增文件不一致 → exit 1）
 *   node scripts/format-changed.mjs --write      # 就地格式化（只会动本次改到的文件）
 *   node scripts/format-changed.mjs src/a.ts     # 显式文件（本地改动还没提交时用这个；显式文件一律硬门）
 *
 * 环境变量：
 *   GATE_BASE / GITHUB_BASE_SHA / GITHUB_EVENT_BEFORE   base 提交（缺省 origin/main → main）
 *   PRETTIER_BIN                                        prettier 入口（缺省 <MemoryCore>/node_modules/prettier/bin/prettier.cjs）
 *   FORMAT_STRICT_MODIFIED=1                            存量改动文件也硬门（一次性格式 commit 落地后打开）
 *
 * 重测参数平台（改 printWidth 前先跑，别无脑调）：
 *   node scripts/format-changed.mjs --probe-config '{"printWidth":120}'
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, ".."); // MemoryCore/
const REPO_ROOT = path.resolve(PKG_ROOT, "..");
const MAX_BULK = 300; // 超过这个数几乎可以肯定是整仓 reformat
const STRICT_MODIFIED = process.env.FORMAT_STRICT_MODIFIED === "1";

const argv = process.argv.slice(2);
const write = argv.includes("--write");
const probeIdx = argv.indexOf("--probe-config");
const explicit = argv.filter((a) => !a.startsWith("--") && !(probeIdx >= 0 && argv.indexOf(a) === probeIdx + 1));

function fail(msg, code = 2) {
  console.error(`[format-changed] ${msg}`);
  process.exit(code);
}

function git(args, opts = {}) {
  return spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", ...opts });
}

function resolvePrettier() {
  if (process.env.PRETTIER_BIN) {
    if (!existsSync(process.env.PRETTIER_BIN)) fail(`PRETTIER_BIN 不存在：${process.env.PRETTIER_BIN}`);
    return process.env.PRETTIER_BIN;
  }
  const local = path.join(PKG_ROOT, "node_modules", "prettier", "bin", "prettier.cjs");
  if (existsSync(local)) return local;
  fail("找不到 prettier：请 `pnpm add -D prettier@^3.9`（或用 PRETTIER_BIN 指向已有二进制）。" +
    "本仓 CI 用 pnpm install 装 devDependencies，不额外全局安装。");
}

function resolveBase() {
  const fromEnv = process.env.GATE_BASE || process.env.GITHUB_BASE_SHA || process.env.GITHUB_EVENT_BEFORE;
  const candidates = [];
  if (fromEnv && !/^0+$/.test(fromEnv)) candidates.push(fromEnv);
  candidates.push("origin/main", "main");
  for (const base of candidates) {
    const rev = git(["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
    if (rev.status === 0) {
      const mergeBase = git(["merge-base", base, "HEAD"]);
      return { base, sha: mergeBase.status === 0 ? mergeBase.stdout.trim() : base };
    }
  }
  return null;
}

function changedTsFromGit() {
  const found = resolveBase();
  if (!found) {
    fail("解析不到 base（origin/main / main / $GATE_BASE 都不可用）。浅克隆请设 fetch-depth: 0，或显式传文件：node scripts/format-changed.mjs <file...>");
  }
  const list = (filter) => {
    const diff = git(["diff", "--name-only", `--diff-filter=${filter}`, `${found.sha}...HEAD`]);
    if (diff.status !== 0) fail(`git diff 失败：${diff.stderr.trim()}`);
    return diff.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((p) => /^MemoryCore\/src\/.+\.ts$/.test(p))
      .map((p) => p.slice("MemoryCore/".length));
  };
  // A=新增，M=修改；R/C（重命名/复制）按修改处理，删掉的文件不参与检查
  return {
    added: list("A"),
    modified: [...list("M"), ...list("R"), ...list("C")],
    base: `${found.base}(${found.sha.slice(0, 8)})`,
  };
}

function explicitFiles() {
  return explicit.map((p) => {
    const abs = path.resolve(process.cwd(), p);
    if (!existsSync(abs)) fail(`文件不存在：${p}`);
    return path.relative(PKG_ROOT, abs).split(path.sep).join("/");
  });
}

function runPrettier(prettier, targets) {
  if (targets.length === 0) return 0;
  const res = spawnSync(process.execPath, [prettier, ...(write ? ["--write"] : ["--check"]), ...targets], {
    cwd: PKG_ROOT,
    stdio: "inherit",
  });
  if (res.error) fail(String(res.error));
  return res.status ?? 1;
}

if (probeIdx >= 0) {
  // 复测参数平台：临时目录里写一个 config，对 src 全量 --list-different 计数（不改文件）
  const cfgPath = path.join(mkdtempSync(path.join(tmpdir(), "prettier-probe-")), "cfg.json");
  writeFileSync(cfgPath, argv[probeIdx + 1] ?? "{}");
  const prettier = resolvePrettier();
  const out = spawnSync(process.execPath, [prettier, "--list-different", "--config", cfgPath, "src/**/*.ts"], {
    cwd: PKG_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  const listOut = out.stdout.split("\n").filter(Boolean);
  console.log(`[format-changed] config=${cfgPath} 不一致文件数=${listOut.length}`);
  if (listOut.length) console.log(listOut.slice(0, 10).join("\n"));
  rmSync(path.dirname(cfgPath), { recursive: true, force: true });
  process.exit(0);
}

let hard;
let soft;
let baseLabel;
if (explicit.length) {
  hard = explicitFiles();
  soft = [];
  baseLabel = "显式文件";
} else {
  const changed = changedTsFromGit();
  baseLabel = changed.base;
  hard = changed.added;
  soft = changed.modified;
  if (STRICT_MODIFIED) {
    hard = [...hard, ...soft];
    soft = [];
  }
}

const total = hard.length + soft.length;
if (total === 0) {
  console.log(`[format-changed] base=${baseLabel}：本次没有改到 MemoryCore/src 下的 .ts，跳过。`);
  process.exit(0);
}
if (total > MAX_BULK) {
  console.warn(
    `[format-changed] ⚠ 本次触及 ${total} 个 .ts（>${MAX_BULK}），疑似整仓 reformat。` +
      " #108 明确禁止一次性 reformat 600 文件：请拆出独立的格式 commit，不要把格式变更混进功能 PR。",
  );
}

const prettier = resolvePrettier();
console.log(
  `[format-changed] base=${baseLabel}，${total} 个文件，${write ? "write" : "check"}；` +
    `硬门（新增）${hard.length} / 告警（存量改动）${soft.length}${STRICT_MODIFIED ? "（已全开硬门）" : ""}。`,
);

if (write) {
  const s1 = runPrettier(prettier, hard);
  const s2 = runPrettier(prettier, soft);
  if (s1 !== 0 || s2 !== 0) {
    console.error("[format-changed] --write 失败：prettier 退出码非 0，见上方输出。");
    process.exit(s1 || s2);
  }
  process.exit(0);
}

const hardStatus = runPrettier(prettier, hard);
if (hardStatus !== 0) {
  console.error("[format-changed] 失败：**新增**的 .ts 必须符合 MemoryCore/.prettierrc；跑 `pnpm run format` 就地修。");
  process.exit(hardStatus);
}

if (soft.length > 0) {
  const softStatus = runPrettier(prettier, soft);
  if (softStatus !== 0) {
    console.warn(
      "[format-changed] 告警（不阻塞）：本次改到的**存量**文件尚未格式化——这是 #108 的存量债务，" +
        "统一刷必须另开纯格式 commit；待其合入后设 FORMAT_STRICT_MODIFIED=1 把本档转硬门。",
    );
  }
}
process.exit(0);
