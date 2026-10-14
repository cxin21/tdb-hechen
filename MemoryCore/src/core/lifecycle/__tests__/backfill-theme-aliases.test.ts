/**
 * #21（I5 descope）：backfill-theme-aliases —— 存量 active theme 锚 aliases 回填（p18 遗留项）。
 *
 * 合同（与 #11 维护环 / F19 同族纪律）：
 * - 目标 = attrs_json 无非空 aliases 的 active theme 锚（SQL 侧过滤，store 适配层给出）；
 * - 证据 = 锚自身租户的 l1_records 按 label 取证（无证据 → 跳过且**不调 LLM**）；
 * - LLM 提议 → 确定性守卫：trim / 去空 / 大小写去重 / 等于 label 剔除 / >12 字剔除 / cap 3；
 * - 守卫后为空 → noAlias 跳过；坏 JSON → skippedBadReply 跳过（不写、不炸）；
 * - 写回 = 读改合并（只动 aliases + aliasesSource 键，description/lastDescRefreshEvidence 等原样保留）；
 * - 缺省 dry-run（零写）；--write 才落库。
 */
import { describe, expect, it } from "vitest";
import { runAliasBackfill, type AliasBackfillDeps } from "../../../../scripts/backfill-theme-aliases.js";

const TENANT = { teamId: "t", userId: "u", agentId: "a" };

interface Row {
  rowid: number;
  value_id: string;
  label: string;
  node_type: string;
  attrs_json: string;
  team_id: string;
  user_id: string;
  agent_id: string;
}

function row(label: string, attrsJson: string, rowid = 1): Row {
  return { rowid, value_id: `v-${rowid}`, label, node_type: "theme", attrs_json: attrsJson, ...TENANT };
}

function scriptedRunner(replies: Record<string, string>) {
  const calls: Array<{ prompt: string }> = [];
  return {
    calls,
    run: async ({ prompt }: { prompt: string }) => {
      calls.push({ prompt });
      for (const [label, reply] of Object.entries(replies)) {
        if (prompt.includes(label)) return reply;
      }
      throw new Error(`unexpected prompt: ${prompt.slice(0, 40)}`);
    },
  };
}

function mkStore(rows: Row[], evidence: Record<string, string[]>) {
  const writes: Array<{ rowid: number; attrsJson: string }> = [];
  return {
    writes,
    listAliasBackfillTargets: (): Row[] => rows,
    sampleEvidence: (_t: typeof TENANT, label: string): string[] => evidence[label] ?? [],
    updateAnchorAttrs: (rowid: number, attrsJson: string): void => {
      writes.push({ rowid, attrsJson });
    },
  };
}

function baseDeps(over: Partial<AliasBackfillDeps> & { store: ReturnType<typeof mkStore>; llmRunner: ReturnType<typeof scriptedRunner> }): AliasBackfillDeps {
  return {
    write: false,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    ...over,
  } as AliasBackfillDeps;
}

describe("backfill-theme-aliases（#21）", () => {
  it("提议合法别名 → 合并写回保留既有 attrs 键 + aliasesSource", async () => {
    const store = mkStore([row("交付质量", JSON.stringify({ description: "关注交付质量。", lastDescRefreshEvidence: 5 }))], { 交付质量: ["本周交付质量复盘。"] });
    const runner = scriptedRunner({ 交付质量: '{"aliases":["交付","验收"]}' });
    const stats = await runAliasBackfill(baseDeps({ store, llmRunner: runner, write: true }));
    expect(stats.proposed).toBe(1);
    expect(store.writes).toHaveLength(1);
    const merged = JSON.parse(store.writes[0].attrsJson);
    expect(merged.aliases).toEqual(["交付", "验收"]);
    expect(merged.aliasesSource).toBe("backfill");
    expect(merged.description).toBe("关注交付质量。");
    expect(merged.lastDescRefreshEvidence).toBe(5);
  });

  it("守卫：trim/去空/大小写去重/等于 label 剔除/超长剔除/cap 3", async () => {
    const store = mkStore([row("交付质量标签", "{}")], { 交付质量标签: ["e"] });
    const runner = scriptedRunner({ 交付质量标签: '{"aliases":["交付"," 交付 ","交付质量标签","","交付","0123456789ABC","验收"]}' });
    await runAliasBackfill(baseDeps({ store, llmRunner: runner, write: true }));
    expect(JSON.parse(store.writes[0].attrsJson).aliases).toEqual(["交付", "验收"]);
  });

  it("坏 JSON 回复 → skippedBadReply，不写", async () => {
    const store = mkStore([row("坏回复锚", "{}")], { 坏回复锚: ["e"] });
    const runner = scriptedRunner({ 坏回复锚: "not json" });
    const stats = await runAliasBackfill(baseDeps({ store, llmRunner: runner, write: true }));
    expect(stats.skippedBadReply).toBe(1);
    expect(stats.written).toBe(0);
    expect(store.writes).toHaveLength(0);
  });

  it("守卫后空别名 → noAlias 跳过", async () => {
    const store = mkStore([row("空别名锚", "{}")], { 空别名锚: ["e"] });
    const runner = scriptedRunner({ 空别名锚: '{"aliases":["空别名锚"]}' });
    const stats = await runAliasBackfill(baseDeps({ store, llmRunner: runner, write: true }));
    expect(stats.noAlias).toBe(1);
    expect(store.writes).toHaveLength(0);
  });

  it("无证据 → 跳过且不调 LLM", async () => {
    const store = mkStore([row("无证据锚", "{}")], {});
    const runner = scriptedRunner({});
    const stats = await runAliasBackfill(baseDeps({ store, llmRunner: runner, write: true }));
    expect(stats.skippedNoEvidence).toBe(1);
    expect(runner.calls).toHaveLength(0);
  });

  it("缺省 dry-run：提议但零写", async () => {
    const store = mkStore([row("干跑锚", "{}")], { 干跑锚: ["e"] });
    const runner = scriptedRunner({ 干跑锚: '{"aliases":["别名"]}' });
    const stats = await runAliasBackfill(baseDeps({ store, llmRunner: runner }));
    expect(stats.proposed).toBe(1);
    expect(stats.written).toBe(0);
    expect(store.writes).toHaveLength(0);
  });

  it("limit 截断处理目标数", async () => {
    const store = mkStore([row("锚A", "{}", 1), row("锚B", "{}", 2), row("锚C", "{}", 3)], { 锚A: ["e"], 锚B: ["e"], 锚C: ["e"] });
    const runner = scriptedRunner({ 锚A: '{"aliases":["a"]}', 锚B: '{"aliases":["b"]}', 锚C: '{"aliases":["c"]}' });
    const stats = await runAliasBackfill(baseDeps({ store, llmRunner: runner, write: true, limit: 2 }));
    expect(stats.scanned).toBe(2);
    expect(runner.calls).toHaveLength(2);
    expect(stats.written).toBe(2);
  });

  it("LLM 抛错 → 该锚计 failed，继续其余锚", async () => {
    const store = mkStore([row("炸锚", "{}", 1), row("好锚", "{}", 2)], { 炸锚: ["e"], 好锚: ["e"] });
    const runner = {
      calls: [] as Array<{ prompt: string }>,
      run: async ({ prompt }: { prompt: string }) => {
        runner.calls.push({ prompt });
        if (prompt.includes("炸锚")) throw new Error("llm boom");
        return '{"aliases":["ok"]}';
      },
    };
    const stats = await runAliasBackfill(baseDeps({ store, llmRunner: runner, write: true }));
    expect(stats.failed).toBe(1);
    expect(stats.written).toBe(1);
    expect(store.writes[0].rowid).toBe(2);
  });
});
