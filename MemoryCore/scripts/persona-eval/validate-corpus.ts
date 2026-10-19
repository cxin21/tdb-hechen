#!/usr/bin/env node
/**
 * R2（#66）语料校验 CLI —— CORPUS_SCHEMA.md §7 十条规则的命令行执行口。
 *
 * 用法:
 *   node --import tsx scripts/persona-eval/validate-corpus.ts [--dir scripts/persona-eval/probes] [--quiet]
 *
 * 退出码: 0=通过（含 warning）；1=存在 issue；2=IO/用法错。
 * 语料成员（T2）在每次增改探针后跑本命令自检；runner --no-llm 干跑复用同一套校验。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProbesFromDir, validateCorpus } from "./lib.js";

function argOf(name: string): string | undefined {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const here = dirname(fileURLToPath(import.meta.url));
  const defaultDir = resolve(here, "probes");
  const dirArg = argOf("dir");
  const dir = dirArg ? resolve(process.cwd(), dirArg) : defaultDir;
  const quiet = process.argv.includes("--quiet");
  if (dirArg && !existsSync(dir)) {
    console.error("[validate-corpus] 探针目录不存在: " + dir);
    return 2;
  }

  const { probes, errors } = loadProbesFromDir(dir);
  const { issues, warnings } = validateCorpus(probes);

  // fixtures 辅助文件格式校验（schema 规则 7/8）。
  const fixturesDir = resolve(dirname(dir), "fixtures");
  const goldenPath = join(fixturesDir, "golden-samples.json");
  if (existsSync(goldenPath)) {
    try {
      const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as { cases?: unknown };
      if (!Array.isArray(golden.cases)) {
        issues.push("fixtures/golden-samples.json: cases 必须是数组");
      } else {
        const ids = new Set(probes.map((p) => p.id));
        const assertionIds = new Set(probes.flatMap((p) => p.assertions.map((a) => a.id)));
        golden.cases.forEach((c, i) => {
          const cc = c as { probeId?: unknown; expected?: unknown; reply?: unknown };
          if (typeof cc.probeId !== "string" || !ids.has(cc.probeId)) {
            issues.push(`fixtures/golden-samples.json: cases[${i}].probeId 不存在于探针库`);
          }
          if (typeof cc.reply !== "string") issues.push(`fixtures/golden-samples.json: cases[${i}].reply 必须是逐字原文 string`);
          if (!Array.isArray(cc.expected)) {
            issues.push(`fixtures/golden-samples.json: cases[${i}].expected 必须是数组`);
          } else {
            cc.expected.forEach((e, j) => {
              const ee = e as { assertionId?: unknown; pass?: unknown };
              if (typeof ee.assertionId !== "string" || !assertionIds.has(ee.assertionId)) {
                issues.push(`fixtures/golden-samples.json: cases[${i}].expected[${j}].assertionId 不存在于探针库`);
              }
              if (typeof ee.pass !== "boolean") {
                issues.push(`fixtures/golden-samples.json: cases[${i}].expected[${j}].pass 必须是 boolean`);
              }
            });
          }
        });
      }
    } catch (err) {
      issues.push("fixtures/golden-samples.json: JSON 解析失败 " + (err instanceof Error ? err.message : String(err)));
    }
  }
  const calibPath = join(fixturesDir, "calibration-subset.json");
  if (existsSync(calibPath)) {
    try {
      const calib = JSON.parse(readFileSync(calibPath, "utf8")) as { probeIds?: unknown; maxProbes?: unknown };
      if (!Array.isArray(calib.probeIds)) {
        issues.push("fixtures/calibration-subset.json: probeIds 必须是数组");
      } else {
        const ids = new Set(probes.map((p) => p.id));
        if (calib.probeIds.length > 6) issues.push("fixtures/calibration-subset.json: probeIds ≤6，得 " + calib.probeIds.length);
        calib.probeIds.forEach((id, i) => {
          if (typeof id !== "string" || !ids.has(id)) {
            issues.push(`fixtures/calibration-subset.json: probeIds[${i}] 不存在于探针库`);
          }
        });
      }
    } catch (err) {
      issues.push("fixtures/calibration-subset.json: JSON 解析失败 " + (err instanceof Error ? err.message : String(err)));
    }
  }

  if (!quiet) {
    console.log("[validate-corpus] probes=" + probes.length + " dir=" + dir);
    for (const w of warnings) console.log("[validate-corpus] WARN " + w);
    for (const i of issues) console.log("[validate-corpus] ISSUE " + i);
    if (issues.length === 0) console.log("[validate-corpus] PASS（" + warnings.length + " warning）");
  } else {
    for (const i of issues) console.log("[validate-corpus] ISSUE " + i);
  }
  return issues.length > 0 ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error("[validate-corpus] fatal:", err instanceof Error ? err.message : String(err));
  process.exit(2);
});
