/**
 * T4（方案 Task 4，2026-10-17）：#42 锚打分器 shadow 定标落盘。
 *
 * 合同（方案 Task 4 Interfaces + ADR0003 D7 ε-定标先例）：
 * - config `coreMemory.soulRender.anchorSelect.shadowSink {enabled, file}`——缺省关
 *   （enabled:false=零写盘零采集零渲染影响，逐位现状）；file 缺省 data/logs/soul-anchor-shadow.jsonl。
 * - 开启后：shadow 打分真实发生时（rows>maxRows + embedder + 可用查询向量，I-4 可用门）
 *   追加一行 jsonl：{ts, agentId, threshold, rowsScored:[{valueId,score}],
 *   wouldSelect:[valueId], actuallySelected:[valueId], agree:boolean}。
 * - 语义：wouldSelect=假设转正（threshold 硬门+top-K）会保留的集合；
 *   actuallySelected=本轮实际渲染集合（#52 D3 选项C：shadow 不重排，value_id 序）；
 *   agree=两者集合相等（按 valueId 去重比较——重复行场景 must 显式覆盖）。
 * - 真实性红线：无向量/打分失败/rows≤maxRows 分支零采集（不造数）；渲染字节零变化；
 *   写失败 fail-safe 降级（warn 一次后静默，与 reflection shadow sink 同哲学）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSoulPrefix } from "../soul-assembler.js";
import { parseConfig } from "../../../config.js";

const TENANT = { teamId: "tsh4", userId: "u1", agentId: "agt-shadow" };

function makeStore(rows: Array<Record<string, unknown>>) {
  return {
    readCore: async () => [] as Array<Record<string, string>>,
    listValues: async () => rows,
  } as never;
}

const themed = (i: number, vid?: string) => ({
  value_id: vid ?? `v${String(i).padStart(2, "0")}`,
  label: `锚${i}`,
  weight: 0.5,
  valence: 1,
  state: "active",
  node_type: "theme",
  attrs_json: `{"description":"第${i}号锚的稳定描述句。"}`,
});

/** 正交 embedder：desc 含「第i号」→ 单位向量 e_i（维度 8）；query 同理（测试直传向量）。 */
const embed = (t: string): Float32Array => {
  const m = /第(\d+)号/.exec(t);
  const idx = m ? Number(m[1]) % 8 : 0;
  const v = new Float32Array(8);
  v[idx] = 1;
  return v;
};

const unit = (idx: number): Float32Array => {
  const v = new Float32Array(8);
  v[idx % 8] = 1;
  return v;
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tempFile = (): string => {
  const d = mkdtempSync(join(tmpdir(), "soul-anchor-shadow-"));
  dirs.push(d);
  return join(d, "shadow.jsonl");
};

describe("T4 #42 shadow 定标落盘", () => {
  it("①sink 缺省/显式关 → 零写盘、渲染字节不变（逐位现状）", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => themed(i));
    const file = tempFile();
    const base = await buildSoulPrefix(makeStore(rows), { ...TENANT, userId: "u-b1" }, undefined, {});
    // 缺省（无 shadowSink 键）
    await buildSoulPrefix(makeStore(rows), { ...TENANT, userId: "u-off1" }, undefined, {
      anchorSelect: { maxRows: 3, scorer: { enabled: false, threshold: 0, embedder: embed }, queryEmbedding: unit(0) } as never,
    });
    // 显式 enabled:false
    await buildSoulPrefix(makeStore(rows), { ...TENANT, userId: "u-off2" }, undefined, {
      anchorSelect: { maxRows: 3, scorer: { enabled: false, threshold: 0, embedder: embed, queryEmbedding: unit(0) }, shadowSink: { enabled: false, file } } as never,
    });
    expect(existsSync(file)).toBe(false);
    const out = await buildSoulPrefix(makeStore(rows), { ...TENANT, userId: "u-off3" }, undefined, {
      anchorSelect: { maxRows: 3, scorer: { enabled: false, threshold: 0, embedder: embed }, queryEmbedding: unit(0) } as never,
    });
    expect(out).toBe(base);
  });

  it("②sink 开 + rows>maxRows + 向量在位 → 一行合法 jsonl，字段齐全，wouldSelect=topK、agree=false", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => themed(i));
    const file = tempFile();
    await buildSoulPrefix(makeStore(rows), { ...TENANT, userId: "u-on1" }, undefined, {
      anchorSelect: { maxRows: 3, scorer: { enabled: false, threshold: 0, embedder: embed, queryEmbedding: unit(0) }, shadowSink: { enabled: true, file } } as never,
    });
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0]) as {
      ts: string; agentId: string; threshold: number;
      rowsScored: Array<{ valueId: string; score: number }>;
      wouldSelect: string[]; actuallySelected: string[]; agree: boolean;
    };
    expect(typeof row.ts).toBe("string");
    expect(row.agentId).toBe("agt-shadow");
    expect(row.threshold).toBe(0);
    expect(row.rowsScored).toHaveLength(8);
    for (const r of row.rowsScored) {
      expect(typeof r.valueId).toBe("string");
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
    // wouldSelect=topK(maxRows=3)；query=e_0 → 锚0 满分在最前
    expect(row.wouldSelect).toHaveLength(3);
    expect(row.wouldSelect[0]).toBe("v00");
    expect(row.actuallySelected).toHaveLength(8);
    expect(row.agree).toBe(false);
  });

  it("③agree=true 场景：重复行去重后集合相等（重复 value_id 行，topK 去重=实际渲染去重）", async () => {
    const rows = [themed(0, "dupA"), themed(0, "dupA"), themed(1, "dupB"), themed(1, "dupB")];
    const file = tempFile();
    await buildSoulPrefix(makeStore(rows), { ...TENANT, userId: "u-on2" }, undefined, {
      anchorSelect: { maxRows: 3, scorer: { enabled: false, threshold: 0, embedder: embed, queryEmbedding: unit(0) }, shadowSink: { enabled: true, file } } as never,
    });
    const row = JSON.parse(readFileSync(file, "utf8").trim()) as { wouldSelect: string[]; actuallySelected: string[]; agree: boolean; rowsScored: unknown[] };
    expect(row.rowsScored).toHaveLength(4); // 每行打分（重复行各自计分）
    expect([...new Set(row.wouldSelect)].sort()).toEqual(["dupA", "dupB"]);
    expect([...new Set(row.actuallySelected)].sort()).toEqual(["dupA", "dupB"]);
    expect(row.agree).toBe(true);
  });

  it("④rows ≤ maxRows → 零采集（shadow 触发门不满足，连打分都不发生）", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => themed(i));
    const file = tempFile();
    await buildSoulPrefix(makeStore(rows), { ...TENANT, userId: "u-on3" }, undefined, {
      anchorSelect: { maxRows: 3, scorer: { enabled: false, threshold: 0, embedder: embed, queryEmbedding: unit(0) }, shadowSink: { enabled: true, file } } as never,
    });
    expect(existsSync(file)).toBe(false);
  });

  it("⑤向量缺席（无 queryEmbedding/provider）→ 零采集不造数（I-4 可用门），渲染现状", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => themed(i));
    const file = tempFile();
    await buildSoulPrefix(makeStore(rows), { ...TENANT, userId: "u-on4" }, undefined, {
      anchorSelect: { maxRows: 3, scorer: { enabled: false, threshold: 0, embedder: embed }, shadowSink: { enabled: true, file } } as never,
    });
    expect(existsSync(file)).toBe(false);
  });

  it("⑥config 解析：缺省关 + file 缺省路径；显式采纳；非法形状回退", () => {
    const def = parseConfig({});
    expect(def.coreMemory.soulRender.anchorSelect.shadowSink.enabled).toBe(false);
    expect(def.coreMemory.soulRender.anchorSelect.shadowSink.file).toBe("data/logs/soul-anchor-shadow.jsonl");
    const on = parseConfig({ coreMemory: { soulRender: { anchorSelect: { shadowSink: { enabled: true, file: "x/y.jsonl" } } } } });
    expect(on.coreMemory.soulRender.anchorSelect.shadowSink.enabled).toBe(true);
    expect(on.coreMemory.soulRender.anchorSelect.shadowSink.file).toBe("x/y.jsonl");
    const bad = parseConfig({ coreMemory: { soulRender: { anchorSelect: { shadowSink: { enabled: "yes", file: 42 } } } } });
    expect(bad.coreMemory.soulRender.anchorSelect.shadowSink.enabled).toBe(false);
    expect(bad.coreMemory.soulRender.anchorSelect.shadowSink.file).toBe("data/logs/soul-anchor-shadow.jsonl");
  });

  it("⑦T6-F3 钉：sink 开启渲染字节零变化——shadow 分支（scorer 关）下 sink on/off 输出逐位相等", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => themed(i));
    const file = tempFile();
    const base = await buildSoulPrefix(makeStore(rows), { ...TENANT, userId: "u-sink-base" }, undefined, {
      anchorSelect: { maxRows: 3, scorer: { enabled: false, threshold: 0, embedder: embed, queryEmbedding: unit(0) } } as never,
    });
    const withSink = await buildSoulPrefix(makeStore(rows), { ...TENANT, userId: "u-sink-on" }, undefined, {
      anchorSelect: { maxRows: 3, scorer: { enabled: false, threshold: 0, embedder: embed, queryEmbedding: unit(0) }, shadowSink: { enabled: true, file } } as never,
    });
    expect(existsSync(file)).toBe(true); // 先证写分支真实发生，字节等价断言才有意义
    expect(withSink).toBe(base);
  });

  it("⑧T6-F3 fail-safe：不可写路径 → warn 一次、渲染不受影响、不抛", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => themed(i));
    const d = mkdtempSync(join(tmpdir(), "soul-anchor-shadow-fail-"));
    dirs.push(d);
    const notADir = join(d, "notadir");
    writeFileSync(notADir, "occupied", "utf8"); // 父路径是文件 → mkdir/append 必失败
    const file = join(notADir, "x.jsonl");
    const warns: string[] = [];
    const spyLogger = { warn: (m: string) => warns.push(m) } as never;
    const base = await buildSoulPrefix(makeStore(rows), { ...TENANT, userId: "u-fail-base" }, undefined, {
      anchorSelect: { maxRows: 3, scorer: { enabled: false, threshold: 0, embedder: embed, queryEmbedding: unit(0) } } as never,
    });
    const out = await buildSoulPrefix(makeStore(rows), { ...TENANT, userId: "u-fail-on" }, spyLogger, {
      anchorSelect: { maxRows: 3, scorer: { enabled: false, threshold: 0, embedder: embed, queryEmbedding: unit(0) }, shadowSink: { enabled: true, file } } as never,
    });
    expect(out).toBe(base); // 渲染主路径零影响
    expect(warns.some((w) => w.includes("[soul-anchor-shadow] write failed"))).toBe(true); // fail-safe 降级告警
  });
});
