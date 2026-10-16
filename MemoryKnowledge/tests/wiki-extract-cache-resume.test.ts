/**
 * ③ extract-cache 断点续跑（长跑被杀全废的根因修复）：
 * runIngestIncremental 阶段1 逐源抽取成功后把候选页缓存到 raw/extract-cache/<safe>-<sha8>.json；
 * 再次运行时 sha 命中的源直接吃缓存、不调 LLM；commitCandidates 成功（无 mergeErrors）后清缓存。
 * 被杀/重启后重跑：已抽取的源不重烧 LLM，只补未抽取的（2026-10-15 06:22/12:21 两次长跑全废的解药）。
 * 强一致约束不变：源状态登记仍只在 run 末尾上层 ingest() 事务内完成。
 */
import { test, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIngestIncremental } from "../src/engines/wiki/manager.js";
import { sha256 } from "../src/engines/wiki/index-db.js";

function makeProject(): { root: string; sourcesDir: string; cacheDir: string } {
  const root = mkdtempSync(join(tmpdir(), "wiki-cache-"));
  const sourcesDir = join(root, "raw", "sources");
  const cacheDir = join(root, "raw", "extract-cache");
  mkdirSync(sourcesDir, { recursive: true });
  return { root, sourcesDir, cacheDir };
}

function cacheFileFor(root: string, filename: string, sha: string) {
  const safe = filename.replace(/[^A-Za-z0-9._-]+/g, "_");
  return join(root, "raw", "extract-cache", `${safe}-${sha.slice(0, 8)}.json`);
}

const UNREACHABLE_LLM = {
  protocol: "openai" as const,
  baseUrl: "http://127.0.0.1:9/v1", // discard 协议端口，连接必拒
  apiKey: "test-key",
  model: "test-model",
};

test("命中缓存的源跳过 LLM 照常落盘，未命中源独立失败，成功 commit 后清缓存", { timeout: 60000 }, async () => {
  const { root, sourcesDir, cacheDir } = makeProject();
  const contentA = "# 源A\n正文A";
  writeFileSync(join(sourcesDir, "A.md"), contentA, "utf-8");
  writeFileSync(join(sourcesDir, "B.md"), "# 源B\n正文B", "utf-8");

  const shaA = sha256(contentA);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    cacheFileFor(root, "A.md", shaA),
    JSON.stringify({
      filename: "A.md",
      sha256: shaA,
      candidates: [["wiki/sources/A页.md", "---\ntype: source\ntitle: A页\n---\n缓存正文A"]],
    }),
    "utf-8",
  );

  const outcome = await runIngestIncremental(root, new Map(), UNREACHABLE_LLM);

  const bySource = new Map(outcome.processed.map((p) => [p.filename, p]));
  expect(bySource.get("A.md")?.ok).toBe(true); // 吃缓存，不碰 LLM
  expect(bySource.get("B.md")?.ok).toBe(false); // 无缓存且 LLM 不可达 → 独立失败

  const pageA = join(root, "wiki", "sources", "A页.md");
  expect(existsSync(pageA)).toBe(true);
  expect(readFileSync(pageA, "utf-8")).toContain("缓存正文A");

  expect(existsSync(cacheDir)).toBe(false); // commit 无 mergeErrors → 缓存目录整个清除
});

test("sha 不匹配的缓存条目不生效（内容变更后必须重抽取）", { timeout: 60000 }, async () => {
  const { root, sourcesDir, cacheDir } = makeProject();
  const contentA = "# 源A\n正文A-new";
  writeFileSync(join(sourcesDir, "A.md"), contentA, "utf-8");
  const shaA = sha256(contentA);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    cacheFileFor(root, "A.md", shaA),
    JSON.stringify({
      filename: "A.md",
      sha256: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      candidates: [["wiki/sources/A页.md", "---\ntype: source\n---\n过期缓存"]],
    }),
    "utf-8",
  );

  const outcome = await runIngestIncremental(root, new Map(), UNREACHABLE_LLM);
  const row = outcome.processed.find((p) => p.filename === "A.md");
  expect(row?.ok).toBe(false);
  expect(existsSync(join(root, "wiki", "sources", "A页.md"))).toBe(false);
});
