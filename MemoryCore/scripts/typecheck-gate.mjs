#!/usr/bin/env node
/**
 * #107 typecheck 基线门禁（MemoryCore）。
 *
 * 背景：MemoryCore 的 npm run typecheck 在 main 上本就是红的（2026-10-31 实测
 * 243 errors / 44 files，权威读数是 docs/audit/2026-10-31-open-issues-first-principles.md §4.4）。
 * 「243 → 243」如果只靠人肉比对，就永远不成其为硬线；本脚本把它变成可执行门禁：
 *
 *   - 跑 tsc -p tsconfig.typecheck.json --pretty false；
 *   - 与同目录的 typecheck-baseline.json 按**(文件, 错误码)** 比较（2026-11-03 起；
 *     中间的「文件面积」判据见 scripts/typecheck-gate-lib.mjs 顶部演进史）；
 *   - **只允许不增加**：某个 (文件, 错误码) 条数变多、或出现基线里没有的
 *     (文件, 错误码) → exit 1，并逐条打印新增明细（文件:行 错误码 首行消息）；
 *     同文件内**名称解析族**（TS2304/TS2552/TS2551）的一增一减抵消只记 INFO；
 *     条数变少只提示（写明用 --update 收紧）。
 *
 * 用法：
 *   node scripts/typecheck-gate.mjs            # 门禁（CI 用）
 *   node scripts/typecheck-gate.mjs --update   # 重锁基线（人工确认后单独 commit）
 *   node --test scripts/typecheck-gate.test.mjs  # 判据自身的用例（零依赖）
 *
 * 环境变量：
 *   TSC_BIN             覆盖 tsc 入口（缺省 <MemoryCore>/node_modules/typescript/bin/tsc）。
 *   TYPECHECK_BASELINE  覆盖基线文件路径（缺省 <MemoryCore>/typecheck-baseline.json）；
 *                       用于「拿另一份基线对照跑」的自测，不改仓库里的真基线。
 *
 * 说明：本脚本不修错误，也不区分「谁引入的」——它只回答「本次改动有没有新增红的组合」。
 *
 * 历史：generated/schemas.ts 曾是第一大错误源（51 条 Cannot find name，wiki /
 * code-graph 两段引用了 11 个从未定义的 schema 与 40 个从未定义的类型名）。
 * 2026-11-02 已按上游 MemoryKnowledge/openapi.yaml（ecc01a5）手工补齐定义，
 * 基线随之从 202/30 收紧到 149/28；补定义的理由与未验证边界见
 * src/gateway/generated/types.ts 尾部注释，闭合不变量由
 * src/gateway/generated-schema-closure.test.ts 守护。Kubb 源 spec
 * （docs/team-api-仅memory.yaml）仍不在仓内，故 generated/ 依旧不能重生成。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compareDiagnostics, groupAsObject, parseDiagnostics } from "./typecheck-gate-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = process.env.TYPECHECK_BASELINE
  ? path.resolve(process.env.TYPECHECK_BASELINE)
  : path.join(ROOT, "typecheck-baseline.json");
const TSCONFIG = "tsconfig.typecheck.json";
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

function main() {
  const output = runTsc();
  const current = parseDiagnostics(output);

  if (update) {
    const payload = {
      $comment:
        "MemoryCore typecheck 基线（#107）。由 scripts/typecheck-gate.mjs --update 生成；" +
        "门禁按 (文件, 错误码) 只允许条数不增加（名称解析族内互换归 INFO），" +
        "重锁基线必须人工确认后单独 commit。",
      generatedAt: current.generatedAt ?? new Date().toISOString(),
      tsconfig: current.tsconfig ?? TSCONFIG,
      total: current.total,
      fileCount: current.fileCount,
      globalErrors: current.globalErrors,
      byCode: current.byCode,
      byFile: current.byFile,
      groups: groupAsObject(current.byGroup),
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

  const { added, removed, reclassified } = compareDiagnostics(current, baseline);
  const baseTotal = baseline.total ?? 0;
  const delta = current.total - baseTotal;

  console.log(
    `[typecheck-gate] 当前 ${current.total} errors / ${current.fileCount} files；` +
      `基线 ${baseTotal} errors / ${baseline.fileCount ?? "?"} files；Δ=${delta >= 0 ? "+" : ""}${delta}`,
  );

  if (reclassified.length > 0) {
    console.log(
      `[typecheck-gate] INFO：${reclassified.length} 个文件的名称解析族码互换已抵消（不算新增）：`,
    );
    for (const r of reclassified.slice(0, 10)) {
      const fmt = (mix) =>
        Object.entries(mix)
          .map(([code, n]) => `${code}×${n}`)
          .join(" ") || "—";
      console.log(`  ~ ${r.file}: ${fmt(r.before)} → ${fmt(r.after)}`);
    }
  }

  if (added.length === 0) {
    if (removed.length > 0) {
      console.log(
        `[typecheck-gate] 有 ${removed.length} 个 (文件, 错误码) 条数减少（好事）；` +
        "如需收紧基线，人工确认后运行 --update。",
      );
    }
    console.log("[typecheck-gate] PASS：未新增 typecheck 错误。");
    return;
  }

  const grew = added.filter((a) => a.file !== "<global>");
  if (delta <= 0) {
    // 总数降了也照样 FAIL：判据是 (文件, 错误码)，别处的修复不能抵掉这里新引入的错误。
    console.error(
      `[typecheck-gate] 总数虽降 ${delta}，但有 ${grew.length} 个文件错误变多或新出现、` +
        `${added.length - grew.length} 条全局错误新增；按 (文件, 错误码) 判，不按总数判。`,
    );
  }
  console.error("[typecheck-gate] FAIL：typecheck 错误变多。新增明细：");
  const addedFiles = new Set(grew.map((a) => a.file));
  let printed = 0;
  for (const detail of current.details) {
    const hit = detail.file === "<global>" || addedFiles.has(detail.file);
    if (!hit) continue;
    if (printed >= MAX_DETAIL_LINES) {
      console.error(`  … 其余新增明细省略（上限 ${MAX_DETAIL_LINES} 行；完整输出见 tsc 原始日志）`);
      break;
    }
    const where = detail.file === "<global>" ? "<global>" : `${detail.file}:${detail.line}`;
    console.error(`  + ${where}  ${detail.code}  ${detail.message.slice(0, 160)}`);
    printed += 1;
  }
  for (const a of added.slice(0, 20)) {
    const tag = a.newFile ? "新文件" : "条数变大";
    const where = a.file === "<global>" ? "<global>" : `${a.file} [${a.code}]`;
    console.error(`  ~ ${where} (${tag}): 基线 ${a.before} → 现在 ${a.after}`);
  }
  process.exit(1);
}

main();
