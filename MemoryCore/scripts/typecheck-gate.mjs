#!/usr/bin/env node
/**
 * #107 typecheck 基线门禁（MemoryCore）。
 *
 * 背景：MemoryCore 的 npm run typecheck 在 main 上本就是红的（2026-10-31 实测
 * 243 errors / 44 files，权威读数是 docs/audit/2026-10-31-open-issues-first-principles.md §4.4）。
 * 「243 → 243」如果只靠人肉比对，就永远不成其为硬线；本脚本把它变成可执行门禁：
 *
 *   - 跑 tsc -p tsconfig.typecheck.json --pretty false；
 *   - 与同目录的 typecheck-baseline.json（文件 × 错误码 × 条数）逐组比对；
 *   - **只允许不增加**：任一组（文件+错误码）条数变多，或出现基线里没有的组合 → exit 1，
 *     并逐条打印新增明细（文件:行 错误码 首行消息）；条数变少只提示（写明用 --update 收紧）。
 *
 * 用法：
 *   node scripts/typecheck-gate.mjs            # 门禁（CI 用）
 *   node scripts/typecheck-gate.mjs --update   # 重锁基线（人工确认后单独 commit）
 *
 * 环境变量：
 *   TSC_BIN             覆盖 tsc 入口（缺省 <MemoryCore>/node_modules/typescript/bin/tsc）。
 *   TYPECHECK_BASELINE  覆盖基线文件路径（缺省 <MemoryCore>/typecheck-baseline.json）；
 *                       用于「拿另一份基线对照跑」的自测，不改仓库里的真基线。
 *
 * 说明：本脚本不修错误，也不区分「谁引入的」——它只回答「本次改动有没有把红的面积做大」。
 * generated/schemas.ts（51 错，当前第一大源）应重生成而非手改，见 #107 票面。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = process.env.TYPECHECK_BASELINE
  ? path.resolve(process.env.TYPECHECK_BASELINE)
  : path.join(ROOT, "typecheck-baseline.json");
const TSCONFIG = "tsconfig.typecheck.json";
// <file>(<line>,<col>): error TSxxxx: <message>；相对路径由 tsc 直接给出（相对 -p 的目录）
const DIAG_RE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
// 无位置信息的全局错误（如 TS5055）——同样计入，不允许静默漏掉
const GLOBAL_RE = /^error (TS\d+): (.*)$/;
const MAX_DETAIL_LINES = 40;

const update = process.argv.includes("--update");

function runTsc() {
  const tscBin = process.env.TSC_BIN
    ? path.resolve(process.env.TSC_BIN)
    : path.join(ROOT, "node_modules", "typescript", "bin", "tsc");
  if (!existsSync(tscBin)) {
    console.error(`[typecheck-gate] 找不到 tsc：${tscBin}（先 pnpm install，或用 TSC_BIN 指定）`);
    process.exit(2);
  }
  const res = spawnSync(process.execPath, [tscBin, "-p", TSCONFIG, "--pretty", "false"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) {
    console.error(`[typecheck-gate] 运行 tsc 失败：${res.error.message}`);
    process.exit(2);
  }
  // tsc 退出码：0=无错，2=有编译错误（正常路径），其他=工具级失败
  if (res.status !== 0 && res.status !== 2) {
    console.error(`[typecheck-gate] tsc 异常退出 status=${res.status}`);
    console.error((res.stdout || "") + (res.stderr || ""));
    process.exit(2);
  }
  return (res.stdout || "") + (res.stderr || "");
}

function collect(output) {
  const byFile = {};
  const byCode = {};
  const byGroup = {}; // "file\0CODE" -> count
  const details = []; // 原始明细，仅用于打印新增
  let globalErrors = 0;

  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = DIAG_RE.exec(line);
    if (m) {
      const file = m[1].split(path.sep).join("/");
      const code = m[4];
      byFile[file] = (byFile[file] || 0) + 1;
      byCode[code] = (byCode[code] || 0) + 1;
      const group = file + "\u0000" + code;
      byGroup[group] = (byGroup[group] || 0) + 1;
      details.push({ file, line: Number(m[2]), code, message: m[5] });
      continue;
    }
    const g = GLOBAL_RE.exec(line);
    if (g) {
      globalErrors += 1;
      details.push({ file: "<global>", line: 0, code: g[1], message: g[2] });
    }
  }

  const total = details.length;
  return {
    generatedAt: new Date().toISOString(),
    tsconfig: TSCONFIG,
    total,
    fileCount: Object.keys(byFile).length,
    globalErrors,
    byCode: sortObject(byCode),
    byFile: sortObject(byFile),
    // byGroup 不进基线文件（体积），必要时从 byFile/byCode 重建比对；见 compare()
    byGroup,
    details,
  };
}

function sortObject(obj) {
  const out = {};
  for (const key of Object.keys(obj).sort()) out[key] = obj[key];
  return out;
}

function compare(current, baseline) {
  const baseGroup = {};
  for (const [file, count] of Object.entries(baseline.byFile || {})) {
    baseGroup[file] = count;
  }
  // 基线按「文件 × 错误码」保存需两份交叉表；这里用 baseline.groups 若存在，否则退化为按文件总数比较
  const groups = baseline.groups || null;
  const added = [];
  const removed = [];

  if (groups) {
    const keys = new Set([...Object.keys(groups), ...Object.keys(current.byGroup)]);
    for (const key of keys) {
      const before = groups[key] || 0;
      const after = current.byGroup[key] || 0;
      if (after > before) added.push({ key, before, after });
      else if (after < before) removed.push({ key, before, after });
    }
  }

  if (current.globalErrors > (baseline.globalErrors || 0)) {
    added.push({ key: "<global>\u0000GLOBAL", before: baseline.globalErrors || 0, after: current.globalErrors });
  }
  return { added, removed, baseGroup };
}

function main() {
  const output = runTsc();
  const current = collect(output);

  if (update) {
    const payload = {
      $comment:
        "MemoryCore typecheck 基线（#107）。由 scripts/typecheck-gate.mjs --update 生成；" +
        "门禁只允许条数不增加，重锁基线必须人工确认后单独 commit。",
      generatedAt: current.generatedAt,
      tsconfig: current.tsconfig,
      total: current.total,
      fileCount: current.fileCount,
      globalErrors: current.globalErrors,
      byCode: current.byCode,
      byFile: current.byFile,
      groups: sortObject(groupAsObject(current.byGroup)),
    };
    writeFileSync(BASELINE_PATH, JSON.stringify(payload, null, 2) + "\n", "utf8");
    console.log(
      `[typecheck-gate] 基线已写入 ${path.relative(process.cwd(), BASELINE_PATH)}：` +
        `${current.total} errors / ${current.fileCount} files`,
    );
    return;
  }

  if (!existsSync(BASELINE_PATH)) {
    console.error(
      `[typecheck-gate] 缺基线文件 ${path.relative(process.cwd(), BASELINE_PATH)}；` +
        "先运行 node scripts/typecheck-gate.mjs --update 并提交基线。",
    );
    process.exit(2);
  }

  let baseline;
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  } catch (err) {
    console.error(`[typecheck-gate] 基线文件解析失败：${err.message}`);
    process.exit(2);
  }

  const { added, removed } = compare(current, baseline);
  const baseTotal = baseline.total ?? 0;
  const delta = current.total - baseTotal;

  console.log(
    `[typecheck-gate] 当前 ${current.total} errors / ${current.fileCount} files；` +
      `基线 ${baseTotal} errors / ${baseline.fileCount ?? "?"} files；Δ=${delta >= 0 ? "+" : ""}${delta}`,
  );

  if (added.length === 0 && current.total <= baseTotal) {
    if (removed.length > 0) {
      console.log(
        `[typecheck-gate] 有 ${removed.length} 组错误减少（好事）；` +
          "如需收紧基线，人工确认后运行 --update。",
      );
    }
    console.log("[typecheck-gate] PASS：未新增 typecheck 错误。");
    return;
  }

  if (delta <= 0) {
    // 总数降了也照样 FAIL：判据是「组」，不是总数——别处的修复不能抵掉这里新引入的错误。
    console.error(
      `[typecheck-gate] 总数虽降 ${delta}，但有 ${added.length} 组数量变多或新出现；按组判，不按总数判。`,
    );
  }
  console.error("[typecheck-gate] FAIL：typecheck 错误增加（或出现基线外的新组合）。新增明细：");
  const addedKeys = new Set(added.map((a) => a.key));
  let printed = 0;
  for (const detail of current.details) {
    const key = detail.file + "\u0000" + detail.code;
    if (!addedKeys.has(key) && detail.file !== "<global>") continue;
    if (printed >= MAX_DETAIL_LINES) {
      console.error(`  … 其余新增明细省略（上限 ${MAX_DETAIL_LINES} 行；完整输出见 tsc 原始日志）`);
      break;
    }
    const where = detail.file === "<global>" ? "<global>" : `${detail.file}:${detail.line}`;
    console.error(`  + ${where}  ${detail.code}  ${detail.message.slice(0, 160)}`);
    printed += 1;
  }
  for (const a of added.slice(0, 20)) {
    const [file, code] = a.key.split("\u0000");
    console.error(`  ~ ${file} ${code}: 基线 ${a.before} → 现在 ${a.after}`);
  }
  process.exit(1);
}

function groupAsObject(byGroup) {
  const out = {};
  for (const [key, count] of Object.entries(byGroup)) {
    out[key] = count;
  }
  return out;
}

main();
