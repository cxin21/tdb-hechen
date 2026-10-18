#!/usr/bin/env node
/**
 * #62 [S24] 行为级一致性 judge 探针 CLI（生产实跑入口）。
 *
 * 用法:
 *   node --import tsx scripts/run-behavior-judge.ts --config tdai-gateway.yaml \
 *        [--soul soul.txt] [--out /tmp/behavior-judge.jsonl] [--limit N] [--no-soul]
 *
 * 流程: parseConfig(yaml) → llm 段构 StandaloneLLMRunner（query-expand 同构）→
 *       （可选）gateway /v3/soul/introspect 拉真实 soul 渲染注入第一跳 →
 *       逐探针两跳（agent / judge）→ JSONL 报告。
 * 退出码: 0=全 pass；1=存在 fail；2=LLM/配置不可用；3=网络/参数错。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { behaviorProbes } from "../src/core/hooks/__tests__/behavior-judge-probes.fixtures.js";
import { runBehaviorProbes } from "../src/core/hooks/behavior-judge.js";
import { parseConfig } from "../src/config.js";

function argOf(name: string): string | undefined {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const configPath = argOf("config") ?? "tdai-gateway.yaml";
  const outPath = argOf("out");
  const soulPath = argOf("soul");
  const limitRaw = argOf("limit");
  const noSoul = process.argv.includes("--no-soul");
  const limit = limitRaw != null ? Math.max(1, Math.floor(Number(limitRaw) || behaviorProbes.length)) : behaviorProbes.length;

  // 配置 → LLM runner（与 query-expand resolveQueryExpansionRunner 同构；进程隔离，无共享缓存）。
  let rawConfig: Record<string, unknown>;
  try {
    const { YAML } = await import("yaml");
    rawConfig = YAML.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  } catch (err) {
    console.error("[behavior-judge] config read/parse failed:", err instanceof Error ? err.message : String(err));
    return 3;
  }
  const cfg = parseConfig(rawConfig);
  let runner: Parameters<typeof runBehaviorProbes>[1] = undefined;
  try {
    const { StandaloneLLMRunner } = await import("../src/adapters/standalone/llm-runner.js");
    const { resolveStandaloneLlmForRuntime } = await import("../src/adapters/standalone/llm-provider-resolver.js");
    const llm = cfg.llm;
    if (llm?.baseUrl && llm?.apiKey) {
      const effective = resolveStandaloneLlmForRuntime(llm as never, "default");
      runner = new StandaloneLLMRunner({
        config: {
          baseUrl: effective.baseUrl,
          apiKey: effective.apiKey,
          model: effective.model ?? "default",
          timeoutMs: effective.timeoutMs ?? 120_000,
          stream: effective.stream ?? false,
        },
      }) as unknown as Parameters<typeof runBehaviorProbes>[1];
    }
  } catch (err) {
    console.error("[behavior-judge] llm runner unavailable:", err instanceof Error ? err.message : String(err));
  }
  if (!runner) {
    console.error("[behavior-judge] no llm runner (check memory.llm.baseUrl/apiKey) — exit 2");
    return 2;
  }

  // 可选：拉生产真实 soul 渲染注入第一跳（gateway /v3/soul/introspect，缺省租户三 default）。
  let soulRendered: string | undefined;
  if (!noSoul) {
    if (soulPath) {
      soulRendered = readFileSync(soulPath, "utf8");
    } else {
      try {
        const endpoint = "http://127.0.0.1:8420";
        const res = await fetch(endpoint + "/v3/soul/introspect", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer " + (process.env.TDAI_GATEWAY_API_KEY ?? "") },
          body: JSON.stringify({}),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
          const body = (await res.json()) as { data?: { rendered?: string } };
          if (body.data?.rendered) soulRendered = body.data.rendered;
        }
      } catch { /* introspect 不可用 → 裸基线对照 */ }
      if (!soulRendered) console.error("[behavior-judge] soul introspect unavailable — running bare baseline");
    }
  }

  const probes = behaviorProbes.slice(0, limit);
  console.error("[behavior-judge] probes=" + probes.length + " soul=" + (soulRendered ? "injected(" + soulRendered.length + " chars)" : "bare"));
  const results = await runBehaviorProbes(probes, runner, { soulRendered });

  const lines = results.map((r) =>
    JSON.stringify({ ts: new Date().toISOString(), id: r.id, category: r.category, reply: r.reply, verdict: r.verdict, elapsedMs: r.elapsedMs }),
  );
  if (outPath) {
    writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
    console.error("[behavior-judge] report written: " + outPath);
  } else {
    console.log(lines.join("\n"));
  }
  const failed = results.filter((r) => !r.verdict.pass);
  for (const f of failed) console.error("[behavior-judge] FAIL " + f.id + ": " + f.verdict.reason);
  return failed.length > 0 ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error("[behavior-judge] fatal:", err instanceof Error ? err.message : String(err));
  process.exit(3);
});
