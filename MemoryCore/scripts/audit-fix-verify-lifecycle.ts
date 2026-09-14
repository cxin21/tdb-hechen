/**
 * 第四轮生命周期补全验证：A-G 全部新实现项。
 * 用法: node --import tsx scripts/audit-fix-verify-lifecycle.ts
 */
import { parseTimeWindow, inTimeWindow } from "../src/core/tools/content-time-window.js";
import { scoreFor, DEFAULT_FORGETTING_CONFIG, classify } from "../src/core/lifecycle/forgetting/scorer.js";
import { formatSearchResponse, executeMemorySearch } from "../src/core/tools/memory-search.js";
import type { MemorySearchResult } from "../src/core/tools/memory-search.js";
import { VectorStore } from "../src/core/store/sqlite.js";

let pass = 0, fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

(async () => {
  console.log("== D: 时间锚窗解析 ==");
  const now = new Date("2026-09-09T10:00:00+08:00");
  const w1 = parseTimeWindow("昨天我们聊了什么", now);
  check("昨天→单日窗", !!w1 && w1.label === "昨天" && new Date(w1.end).getTime() - new Date(w1.start).getTime() === 86_400_000);
  const w2 = parseTimeWindow("上周的性能问题", now);
  check("上周→7天窗", !!w2 && w2.label === "上周" && new Date(w2.end).getTime() - new Date(w2.start).getTime() === 7 * 86_400_000);
  const w3 = parseTimeWindow("3天前的会议", now);
  check("3天前→跨度窗", !!w3 && w3.label === "3天前");
  const w4 = parseTimeWindow("hello world 无时间", now);
  check("无锚→null（不过滤）", w4 === null);
  const w5 = parseTimeWindow("9月的提交", now);
  check("9月→当月窗", !!w5 && w5.label === "9月" && new Date(w5.start).getTime() < now.getTime() && new Date(w5.end).getTime() > new Date("2026-09-05").getTime());
  check("inTimeWindow 命中", inTimeWindow("2026-09-08T12:00:00Z", w1!));
  check("inTimeWindow 不命中", !inTimeWindow("2026-01-01T00:00:00Z", w1!));
  check("inTimeWindow 无时间不拦", inTimeWindow(undefined, w1!));

  console.log("== C: 重巩固抗遗忘 boost ==");
  const base = { id: "m", content: "x", type: "episodic" as const, priority: 50, scene_name: "s", source_message_ids: [], timestamps: [], certainty: "observed" as const, createdAt: "", updatedAt: "", version: 1, occurred_at: new Date(Date.now() - 200 * 86_400_000).toISOString(), significance: 0.3 };
  const cfg = DEFAULT_FORGETTING_CONFIG;
  const s0 = scoreFor(base as never, cfg);
  const withRecall = { ...base, metadata: { recall_count: 3 } };
  const s1 = scoreFor(withRecall as never, cfg);
  check("recall_count=3 boost≈+0.06", Math.abs(s1 - s0 - 0.06) < 1e-9);
  const capped = { ...base, metadata: { recall_count: 99 } };
  check("boost 封顶 +0.10", Math.abs(scoreFor(capped as never, cfg) - s0 - 0.10) < 1e-9);
  const noMeta = scoreFor(base as never, cfg);
  check("无 recall_count 零 boost", noMeta === s0);
  // 临界救回：s0 本该 archive（0.4×0.5×e^{-0.6}≈0.110 < 0.12），boost 后 keep（≈0.170）
  const criticalBase = { ...base, significance: 0.4, occurred_at: new Date(Date.now() - 60 * 86_400_000).toISOString() };
  const criticalRecalled = { ...criticalBase, metadata: { recall_count: 3 } };
  check("临界记忆被救回 keep", classify(criticalBase as never, cfg) === "archive" && classify(criticalRecalled as never, cfg) === "keep");

  console.log("== E: 片段预算截断 ==");
  const mock: MemorySearchResult = {
    results: Array.from({ length: 20 }, (_, i) => ({
      id: `m${i}`, content: `内容条目${i} `.repeat(20), type: "episodic", priority: 50, scene_name: "s",
      score: 0.8, version: 1,
    })) as never,
    total: 20,
    strategy: "fts",
  };
  const full = formatSearchResponse(mock);
  const cappedText = formatSearchResponse(mock, 2000);
  check("不限=完整", full.length > 3000);
  check("预算 2000 生效且带截断提示", cappedText.length <= 2000 + 40 && cappedText.includes("片段预算截断"));

  console.log("== F: formatSearchResponse 持续态优先 ==");
  const mixed: MemorySearchResult = {
    results: [
      { id: "p1", content: "点状", type: "episodic", priority: 90, scene_name: "s", score: 0.9, version: 1, occurred_at: "2026-09-08T01:00:00Z" },
      { id: "d1", content: "持续态结论", type: "work_fact", priority: 80, scene_name: "consolidated", score: 0.5, version: 1, occurred_at: "2026-09-01T00:00:00Z" },
    ] as never,
    total: 2,
    strategy: "fts",
  };
  const mixedText = formatSearchResponse(mixed);
  check("work_fact 排在前", mixedText.indexOf("持续态结论") < mixedText.indexOf("点状"));
  check("持续态带标记", mixedText.includes("🔗持续态"));

  console.log("== C(running): updateL1Metadata 在 store 接口存在 ==");
  const storeProto = VectorStore.prototype as unknown as Record<string, unknown>;
  check("sqlite.updateL1Metadata 已实现", typeof storeProto.updateL1Metadata === "function");
  check("sqlite.pruneOrphanLinks 已实现", typeof storeProto.pruneOrphanLinks === "function");

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
})();