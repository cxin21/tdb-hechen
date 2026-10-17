/**
 * #26（R5）：soul/core 内容源重叠逐日报告（R5-F3 修正：默认全量 entries，
 * 可选第二参 days=N 只统计最近 N 天，名实相符）。
 *
 * #51（H26）口径感知（2026-10-17）：
 *   - 逐行读 norm 字段（旧行无该字段 = 0 口径，解析向后兼容不炸）；
 *   - 报告含「口径切换日」标注（首个 norm>=1 行的日期）；
 *   - days 窗口的三档判定只消费同口径（norm === JOURNAL_NORM_VERSION）数据，
 *     窗口跨切换日 / 窗口内无同口径有效行 → `insufficient-window` 诚实降级，
 *     不套用三档规则（判定逻辑在 src/injection/soul-overlap-report.ts，可单测）。
 *
 * 用法（repo=MemoryProxy）：
 *   pnpm exec tsx scripts/report-soul-overlap.ts [journal.jsonl] [days]
 *   缺省路径 = data/soul-overlap-journal.jsonl（与 observer 缺省一致）
 *   days 省略 = 全量（不套用三档判定）；days=14 = 预注册两周窗
 *
 * ⚠️ 诚实边界（r5-26.md 修正 2）：本报告测得的是「内容源重叠」（journal 侧
 * 逐行 hash 集合），非「注入层重叠」——soul-identity 走 MemoryCore 召回块、
 * core_memory 走主链路 system prompt，两侧不同层；结论适用范围照此声明。
 *
 * 预注册决策规则：
 *   重叠 >80%  → 归一通道（单一注入面）
 *   60–80%     → 标注分工边界（两通道各自声明职责）
 *   <60%       → 维持双通道关票
 */

import { readFileSync, existsSync } from "node:fs";
import {
  JOURNAL_NORM_VERSION,
  jaccard,
  journalNormVersion,
  type SoulOverlapJournalEntry,
} from "../src/injection/soul-overlap-journal.js";
import { decideOverlapWindow, inferNormSwitchDay } from "../src/injection/soul-overlap-report.js";

const DAY_MS = 86_400_000;

function main(): void {
  const file = process.argv[2] ?? "data/soul-overlap-journal.jsonl";
  const daysArg = Number(process.argv[3] ?? "");
  const hasWindow = Number.isFinite(daysArg) && daysArg > 0;
  const nowMs = Date.now();
  const cutoff = hasWindow ? nowMs - daysArg * DAY_MS : null;
  if (!existsSync(file)) {
    console.log(`journal 不存在：${file}（未开启 observation 或尚无数据）`);
    process.exit(0);
  }
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
  const allEntries: SoulOverlapJournalEntry[] = [];
  for (const [i, line] of lines.entries()) {
    try {
      allEntries.push(JSON.parse(line) as SoulOverlapJournalEntry);
    } catch {
      console.error(`[warn] 第 ${i + 1} 行解析失败，跳过`);
    }
  }
  if (allEntries.length === 0) {
    console.log("journal 为空（0 条有效记录）");
    process.exit(0);
  }

  // ── #51 口径感知：口径切换日按全文件计算（不受窗口过滤影响）──
  const switchDay = inferNormSwitchDay(allEntries);
  const windowed =
    cutoff !== null ? allEntries.filter((e) => !(Date.parse(e.ts) < cutoff)) : allEntries;
  if (windowed.length === 0) {
    console.log(`窗口内无有效记录（0 条，最近 ${daysArg} 天）`);
    process.exit(0);
  }

  // ── 逐日聚合（表格保持既有结构；新增 口径(norm) 列）──
  const byDay = new Map<
    string,
    { j: number[]; soulChars: number; coreChars: number; n: number; norms: Set<number> }
  >();
  for (const e of windowed) {
    // R5-F3b：ts 缺失/非法不崩全报告，归入 unknown 桶
    const day = typeof e.ts === "string" && e.ts.length >= 10 ? e.ts.slice(0, 10) : "unknown";
    const agg =
      byDay.get(day) ?? { j: [], soulChars: 0, coreChars: 0, n: 0, norms: new Set<number>() };
    agg.j.push(jaccard(e.soul_line_hashes, e.core_line_hashes));
    agg.soulChars += e.soul_chars;
    agg.coreChars += e.core_chars;
    agg.n++;
    agg.norms.add(journalNormVersion(e)); // #51：逐行口径（缺省=0 旧口径）
    byDay.set(day, agg);
  }

  console.log(
    cutoff !== null
      ? `# soul/core 内容源重叠报告（#26，最近 ${daysArg} 天）`
      : "# soul/core 内容源重叠报告（#26，全量）",
  );
  console.log("");
  console.log(
    `- 口径切换日：${switchDay ?? "无（journal 全为旧口径 norm=0）"}（首个 norm>=1 行日期）；当前写入口径：norm=${JOURNAL_NORM_VERSION}（#51）`,
  );
  console.log("");
  console.log("| 日期 | 轮数 | Jaccard 均值 | soul_chars | core_chars | 估算 token(soul+core) | 口径(norm) |");
  console.log("|---|---|---|---|---|---|---|");
  let totalSoul = 0;
  let totalCore = 0;
  let totalTurns = 0;
  const allJ: number[] = [];
  for (const day of [...byDay.keys()].sort()) {
    const a = byDay.get(day)!;
    const mean = a.j.reduce((x, y) => x + y, 0) / a.j.length;
    totalSoul += a.soulChars;
    totalCore += a.coreChars;
    totalTurns += a.n;
    allJ.push(...a.j);
    console.log(
      `| ${day} | ${a.n} | ${(mean * 100).toFixed(1)}% | ${a.soulChars} | ${a.coreChars} | ~${Math.round((a.soulChars + a.coreChars) / 3.5)} | ${[...a.norms].sort().join("+")} |`,
    );
  }
  const overallMean = allJ.reduce((x, y) => x + y, 0) / allJ.length;
  console.log("");
  console.log(`- 总轮数：${totalTurns}；soul_chars 总量 ${totalSoul}，core_chars 总量 ${totalCore}`);
  console.log(`- Jaccard 全期均值：${(overallMean * 100).toFixed(1)}%`);
  console.log("- 估算 token 成本（近似 3.5 chars/token，仅量级参考）：soul ~" +
    Math.round(totalSoul / 3.5) + "，core ~" + Math.round(totalCore / 3.5));

  // ── #51：days 窗口的三档判定（只消费同口径数据；不足 → insufficient-window）──
  if (hasWindow) {
    const decision = decideOverlapWindow(allEntries, daysArg, nowMs);
    console.log("");
    console.log(`## 窗口三档判定（最近 ${daysArg} 天；#51 口径感知：只消费 norm=${JOURNAL_NORM_VERSION} 同口径数据）`);
    if (decision.status === "insufficient-window") {
      console.log(`- 判定结果：insufficient-window —— ${decision.reason ?? ""}`);
    } else {
      const tierLabel =
        decision.tier === "normalize"
          ? ">80% → 归一通道（单一注入面）"
          : decision.tier === "boundary"
            ? "60–80% → 标注分工边界（两通道各自声明职责）"
            : "<60% → 维持双通道关票";
      console.log(`- 窗口内同口径有效行：${decision.rows ?? 0} 行；Jaccard 全期均值：${((decision.mean ?? 0) * 100).toFixed(1)}%`);
      console.log(`- 判定结果：${tierLabel}`);
    }
  } else {
    console.log("");
    console.log("- 三档判定仅在 days 窗口模式输出（days=14=预注册两周窗）；全量模式不套用三档规则（#51）。");
  }

  console.log("");
  console.log("## 预注册决策规则（r5-26.md，先于数据定案）");
  console.log("- 重叠 >80% → 归一通道（单一注入面）");
  console.log("- 60–80% → 标注分工边界（两通道各自声明职责）");
  console.log("- <60% → 维持双通道关票");
  console.log("");
  console.log("⚠️ 结论适用范围：内容源重叠 ≠ 注入层重叠（soul-identity 走召回块、core_memory 走 system prompt，两侧不同层）。");
}

main();
