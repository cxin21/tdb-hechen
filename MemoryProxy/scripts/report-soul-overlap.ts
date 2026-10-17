/**
 * #26（R5）：soul/core 内容源重叠逐日报告（R5-F3 修正：默认全量 entries，
 * 可选第二参 days=N 只统计最近 N 天，名实相符）。
 *
 * 用法（repo=MemoryProxy）：
 *   pnpm exec tsx scripts/report-soul-overlap.ts [journal.jsonl] [days]
 *   缺省路径 = data/soul-overlap-journal.jsonl（与 observer 缺省一致）
 *   days 省略 = 全量；days=14 = 预注册两周窗
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
import { jaccard, type SoulOverlapJournalEntry } from "../src/injection/soul-overlap-journal.js";

function main(): void {
  const file = process.argv[2] ?? "data/soul-overlap-journal.jsonl";
  const daysArg = Number(process.argv[3] ?? "");
  const cutoff = Number.isFinite(daysArg) && daysArg > 0 ? Date.now() - daysArg * 86_400_000 : null;
  if (!existsSync(file)) {
    console.log(`journal 不存在：${file}（未开启 observation 或尚无数据）`);
    process.exit(0);
  }
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
  const entries: SoulOverlapJournalEntry[] = [];
  for (const [i, line] of lines.entries()) {
    try {
      const e = JSON.parse(line) as SoulOverlapJournalEntry;
      if (cutoff !== null && Date.parse(e.ts) < cutoff) continue; // R5-F3 时间窗过滤
      entries.push(e);
    } catch {
      console.error(`[warn] 第 ${i + 1} 行解析失败，跳过`);
    }
  }
  if (entries.length === 0) {
    console.log("journal 为空（0 条有效记录）");
    process.exit(0);
  }

  // ── 逐日聚合 ──
  const byDay = new Map<string, { j: number[]; soulChars: number; coreChars: number; n: number }>();
  for (const e of entries) {
    // R5-F3b：ts 缺失/非法不崩全报告，归入 unknown 桶
    const day = typeof e.ts === "string" && e.ts.length >= 10 ? e.ts.slice(0, 10) : "unknown";
    const agg = byDay.get(day) ?? { j: [], soulChars: 0, coreChars: 0, n: 0 };
    agg.j.push(jaccard(e.soul_line_hashes, e.core_line_hashes));
    agg.soulChars += e.soul_chars;
    agg.coreChars += e.core_chars;
    agg.n++;
    byDay.set(day, agg);
  }

  console.log(cutoff !== null ? `# soul/core 内容源重叠报告（#26，最近 ${daysArg} 天）` : "# soul/core 内容源重叠报告（#26，全量）");
  console.log("");
  console.log("| 日期 | 轮数 | Jaccard 均值 | soul_chars | core_chars | 估算 token(soul+core) |");
  console.log("|---|---|---|---|---|---|");
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
      `| ${day} | ${a.n} | ${(mean * 100).toFixed(1)}% | ${a.soulChars} | ${a.coreChars} | ~${Math.round((a.soulChars + a.coreChars) / 3.5)} |`,
    );
  }
  const overallMean = allJ.reduce((x, y) => x + y, 0) / allJ.length;
  console.log("");
  console.log(`- 总轮数：${totalTurns}；soul_chars 总量 ${totalSoul}，core_chars 总量 ${totalCore}`);
  console.log(`- Jaccard 全期均值：${(overallMean * 100).toFixed(1)}%`);
  console.log("- 估算 token 成本（近似 3.5 chars/token，仅量级参考）：soul ~" +
    Math.round(totalSoul / 3.5) + "，core ~" + Math.round(totalCore / 3.5));
  console.log("");
  console.log("## 预注册决策规则（r5-26.md，先于数据定案）");
  console.log("- 重叠 >80% → 归一通道（单一注入面）");
  console.log("- 60–80% → 标注分工边界（两通道各自声明职责）");
  console.log("- <60% → 维持双通道关票");
  console.log("");
  console.log("⚠️ 结论适用范围：内容源重叠 ≠ 注入层重叠（soul-identity 走召回块、core_memory 走 system prompt，两侧不同层）。");
}

main();
