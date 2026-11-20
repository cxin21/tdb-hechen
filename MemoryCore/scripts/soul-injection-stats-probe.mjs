#!/usr/bin/env node
/**
 * 只读探针：直接调用 /v3/soul/injection/stats 的处理器（不启服务、不连数据库），
 * 用生产 data 目录里的 recall journal + persona-injection.jsonl 出统计。
 *
 *   node --import tsx scripts/soul-injection-stats-probe.mjs --data-dir D:/TDB/data --team <team> [--user <u>] [--agent <a>] [--hours 24] [--include-test]
 */
import path from "node:path";
import { handleSoulInjectionStatsRoute } from "../src/gateway/soul-injection-stats-endpoint.ts";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const dataDir = arg("--data-dir");
if (!dataDir) {
  console.error("usage: node --import tsx scripts/soul-injection-stats-probe.mjs --data-dir <dir> --team <team> [--user u] [--agent a] [--hours 24] [--include-test]");
  process.exit(1);
}
const params = new URLSearchParams();
params.set("team", arg("--team", ""));
if (process.argv.includes("--user")) params.set("user", arg("--user"));
params.set("agent", arg("--agent", "default"));
params.set("hours", arg("--hours", "24"));
if (process.argv.includes("--include-test")) params.set("includeTest", "1");
const url = new URL("http://local/v3/soul/injection/stats?" + params.toString());

const res = { fake: true };
let captured = null;
const ok = await handleSoulInjectionStatsRoute(
  url,
  "GET",
  (_res, status, payload) => { captured = { status, payload }; },
  res,
  { journalDir: path.join(dataDir, "logs", "recall"), pluginLogPath: path.join(dataDir, "logs", "persona-injection.jsonl") },
);
if (!ok || captured === null) {
  console.error("handler did not handle the route");
  process.exit(1);
}
console.log(JSON.stringify(captured, null, 2));
