/**
 * S3 小扫除同形验证（阶段二批 A，7+1 项）：
 *   1. env 双名：gateway apiKey 解析 `TDAI_GATEWAY_APIKEY`（主用，无下划线）
 *      ?? `TDAI_GATEWAY_API_KEY`（存量兼容）?? yaml `server.apiKey`（第三兜底）——
 *      与 MemoryProxy / MemoryPanel 既有 env 名统一（T11+13 审计 M-1）。
 *   2. summarizer significance clamp：组内 sigs 提取处 clamp [0,1]，与
 *      forgetting/scorer.ts significanceOf 同构（C4 审计 Minor #3）——越界
 *      LLM/legacy 值不再污染持续态 salience，界内逐位不变。
 *   3. 结构页附尾上限 MAX_STRUCTURAL_TAIL=3：超出丢弃 + debug 日志
 *      （T18 审计 M-1）—— 断言在 MemoryProxy vitest 侧
 *      （src/injection/injectors/__tests__/wiki-recall-injector.test.ts），
 *      injector 代码在 MemoryProxy，MemoryCore 侧无法 import。
 *   4. 探针词时间戳：server.ts embed 探针词拼 Date.now()，防 provider 侧
 *      同文本 embedding 缓存假探活（T15 审计 M-2）。行为级断言需活体
 *      embedding provider 穿 TdaiGateway，此处用源码钉死（grep 断言），
 *      真实行为由 5min 探针周期观测。
 *   5/6/7. 注释与 finally try/catch（T15 审计 M-3 / 阶段一 M-1 / M-2）：
 *      纯注释不设断言（无行为可测）；第 7 项由 verify-p2-t11-13 回归运行
 *      间接覆盖（cleanup try/catch 不改变断言结果）。
 *   8. CHANGELOG 已知限制登记：文档项，无运行时断言。
 *
 * 断言组（验收契约）：
 *   组 1 env 双名（loadGatewayConfig 全链路，TDAI_GATEWAY_CONFIG 钉空文件隔离）：
 *     a. 仅 TDAI_GATEWAY_APIKEY → 采用；b. 仅 TDAI_GATEWAY_API_KEY → 采用（存量兼容）；
 *     c. 双名同设 → APIKEY（无下划线）优先；d. 双名缺省 + yaml server.apiKey → yaml 兜底。
 *   组 2 clamp 边界（buildDurativeSummary + mock LLMRunner）：
 *     a. 顶层 1.7 → 1；b. 顶层 -0.5 → 0；c. metadata 正越界 1.7 → 1（双兜底路径同 clamp）；
 *     d. metadata 全负 -0.5 → 0（独立断言，S6 修正 M-3：原 c/d 合并为混合组断言 max=1，
 *        与头注释"d. metadata -0.5 → 0"错位——全负路径无独立覆盖）；e. 界内 0.8 原样（不回归）。
 *   组 4 源码钉死：server.ts 探针 embed 调用含 Date.now() 插值。
 *
 * 用法（在 MemoryCore 目录下）：
 *   node --import tsx scripts/verify-s3.ts
 *
 * 只用临时空配置文件与内存对象，不连任何线上资源、不碰生产数据目录；跑完自动清理。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadGatewayConfig } from "../src/gateway/config.js";
import { buildDurativeSummary } from "../src/core/lifecycle/consolidation/summarizer.js";
import type { LLMRunner } from "../src/types.js";
import type { MemoryRecord } from "../src/core/record/l1-writer.js";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── 断言组 1：env 双名解析（loadGatewayConfig 全链路）────────────────────

function testEnvDualName(): void {
  console.log("\n断言组 1 — gateway apiKey env 双名（APIKEY 主用 / API_KEY 兼容 / yaml 兜底）");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-s3-"));
  const emptyCfg = path.join(tmpDir, "empty-gateway.yaml");
  fs.writeFileSync(emptyCfg, ""); // 空配置文件钉死唯一来源（不命中 CWD tdai-gateway.yaml）
  const yamlCfg = path.join(tmpDir, "yaml-key-gateway.yaml");
  fs.writeFileSync(yamlCfg, "server:\n  apiKey: from-yaml-key\n");

  const prevConfigPath = process.env.TDAI_GATEWAY_CONFIG;
  const prevNoUnderscore = process.env.TDAI_GATEWAY_APIKEY;
  const prevUnderscore = process.env.TDAI_GATEWAY_API_KEY;
  const restore = (): void => {
    if (prevConfigPath === undefined) delete process.env.TDAI_GATEWAY_CONFIG;
    else process.env.TDAI_GATEWAY_CONFIG = prevConfigPath;
    if (prevNoUnderscore === undefined) delete process.env.TDAI_GATEWAY_APIKEY;
    else process.env.TDAI_GATEWAY_APIKEY = prevNoUnderscore;
    if (prevUnderscore === undefined) delete process.env.TDAI_GATEWAY_API_KEY;
    else process.env.TDAI_GATEWAY_API_KEY = prevUnderscore;
  };

  try {
    process.env.TDAI_GATEWAY_CONFIG = emptyCfg;
    delete process.env.TDAI_GATEWAY_APIKEY;
    delete process.env.TDAI_GATEWAY_API_KEY;

    // a. 仅 TDAI_GATEWAY_APIKEY（无下划线，主用名——与 MemoryProxy/Panel 对齐）
    process.env.TDAI_GATEWAY_APIKEY = "key-no-underscore";
    const a = loadGatewayConfig({});
    check("a. 仅 APIKEY → 采用", a.server?.apiKey === "key-no-underscore", `got=${a.server?.apiKey}`);
    delete process.env.TDAI_GATEWAY_APIKEY;

    // b. 仅 TDAI_GATEWAY_API_KEY（存量兼容名）
    process.env.TDAI_GATEWAY_API_KEY = "key-legacy";
    const b = loadGatewayConfig({});
    check("b. 仅 API_KEY → 采用（存量兼容）", b.server?.apiKey === "key-legacy", `got=${b.server?.apiKey}`);
    delete process.env.TDAI_GATEWAY_API_KEY;

    // c. 双名同设 → APIKEY（无下划线）优先
    process.env.TDAI_GATEWAY_APIKEY = "key-no-underscore";
    process.env.TDAI_GATEWAY_API_KEY = "key-legacy";
    const c = loadGatewayConfig({});
    check("c. 双名同设 → APIKEY 优先", c.server?.apiKey === "key-no-underscore", `got=${c.server?.apiKey}`);
    delete process.env.TDAI_GATEWAY_APIKEY;
    delete process.env.TDAI_GATEWAY_API_KEY;

    // d. 双名缺省 → yaml server.apiKey 兜底（第三优先级不回归）
    process.env.TDAI_GATEWAY_CONFIG = yamlCfg;
    const d = loadGatewayConfig({});
    check("d. env 缺省 → yaml server.apiKey 兜底", d.server?.apiKey === "from-yaml-key", `got=${d.server?.apiKey}`);
  } finally {
    restore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── 断言组 2：summarizer significance clamp 边界 ─────────────────────────

function mockRunner(): LLMRunner {
  return {
    run: async () => JSON.stringify({ content: "持续态摘要内容", certainty: "observed" }),
  } as unknown as LLMRunner;
}

function mkGroup(sigs: Array<number | undefined>): {
  subject: string;
  memories: MemoryRecord[];
  earliestTs: number;
  latestTs: number;
} {
  return {
    subject: "测试主题",
    memories: sigs.map((s, i) => (s === undefined
      ? { id: `m${i}`, type: "fact", content: `记忆${i}`, occurredAt: "2026-09-10T00:00:00Z" }
      : { id: `m${i}`, type: "fact", content: `记忆${i}`, occurredAt: "2026-09-10T00:00:00Z", significance: s })) as unknown as MemoryRecord[],
    earliestTs: Date.parse("2026-09-09T00:00:00Z"),
    latestTs: Date.parse("2026-09-10T00:00:00Z"),
  };
}

/** metadata 双兜底路径组：顶层无 significance，真值在 metadata.significance（S6 修正 M-3 拆分用）。 */
function mkMetaGroup(sigs: number[]): {
  subject: string;
  memories: MemoryRecord[];
  earliestTs: number;
  latestTs: number;
} {
  return {
    subject: "测试主题-meta",
    memories: sigs.map((s, i) => ({ id: `m${i}`, type: "fact", content: `记忆${i}`, occurredAt: "2026-09-10T00:00:00Z", metadata: { significance: s } })) as unknown as MemoryRecord[],
    earliestTs: Date.parse("2026-09-09T00:00:00Z"),
    latestTs: Date.parse("2026-09-10T00:00:00Z"),
  };
}

async function testSigClamp(): Promise<void> {
  console.log("\n断言组 2 — summarizer sigs 提取 clamp [0,1]（与 scorer 同构）");
  const runner = mockRunner();

  // a. 顶层越上界 1.7 → 1（两条都越界，sigs.length >= ceil(2/2) 走 max 路径）
  const a = await buildDurativeSummary(mkGroup([1.7, 1.7]), { llmRunner: runner });
  check("a. 顶层 1.7 → clamp 1", a?.significance === 1, `got=${a?.significance}`);

  // b. 顶层越下界 -0.5 → 0
  const b = await buildDurativeSummary(mkGroup([-0.5, -0.5]), { llmRunner: runner });
  check("b. 顶层 -0.5 → clamp 0", b?.significance === 0, `got=${b?.significance}`);

  // c/d 拆分（S6 修正 M-3）：c 只测正越界（1.7 → 1，双兜底路径同 clamp）；
  // d 独立测全负（metadata 全负 → 0）——原混合组只断言 max=1，全负路径无覆盖。
  const c = await buildDurativeSummary(mkMetaGroup([1.7]), { llmRunner: runner });
  check("c. metadata 正越界 1.7 → clamp 1", c?.significance === 1, `got=${c?.significance}`);

  const d = await buildDurativeSummary(mkMetaGroup([-0.5, -0.5]), { llmRunner: runner });
  check("d. metadata 全负 -0.5 → clamp 0", d?.significance === 0, `got=${d?.significance}`);

  // e. 界内 0.8 原样（clamp 不回归既有界内行为）
  const e = await buildDurativeSummary(mkGroup([0.8, 0.6]), { llmRunner: runner });
  check("e. 界内 0.8/0.6 → max=0.8 原样", e?.significance === 0.8, `got=${e?.significance}`);
}

// ── 断言组 4：探针词时间戳（源码钉死）────────────────────────────────────

function testProbeTimestampSourcePin(): void {
  console.log("\n断言组 4 — 探针词拼 Date.now()（源码钉死，行为由 5min 探针观测）");
  // S6 修正 M-4：目录简写（需 Node≥20.11）不可用，改 fileURLToPath(new URL(".", import.meta.url))
  // 模式（Node 20.6 项目底线）；new URL(".", …) 已返回本文件所在目录，不再包 dirname。
  const here = fileURLToPath(new URL(".", import.meta.url));
  const src = fs.readFileSync(path.join(here, "../src/gateway/server.ts"), "utf-8");
  const probeCall = src.split("\n").find((l) => l.includes("emb.embed("));
  check("探针 embed 调用存在", !!probeCall, probeCall?.trim() ?? "（未找到）");
  check("探针词含 Date.now() 插值（防同文本缓存假探活）", !!probeCall && probeCall.includes("Date.now()"));
}

async function main(): Promise<void> {
  console.log("=== S3 小扫除同形验证 ===");
  testEnvDualName();
  await testSigClamp();
  testProbeTimestampSourcePin();

  console.log(`\n=== 结果：${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error("verify script crashed:", err);
  process.exit(1);
});
