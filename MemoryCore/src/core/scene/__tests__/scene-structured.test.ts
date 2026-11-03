/**
 * B3 · L2 结构化形态（task-4 / docs/research/2026-11-02-memory-layering-extraction-optimization.md §6-B）。
 *
 * 病灶：L2 每轮让 LLM 整篇重写场景块，散文体无上界——单块可达数十 KB，
 * 每轮重写都要重新生成全部正文（99 runs/天 × 14 块）。
 * 结构化形态把块拆成：META（索引/召回消费面，必须保留）+ 摘要 + 主张（带 heat）
 * + 事件流（append-only，历史事件只追加不重写），并把单块字节数卡在
 * persona.l2Form.maxBlockBytes（缺省 4096）以内，超出时按 heat 升序裁主张。
 *
 * 不变量：
 *  1. structured=false（缺省）→ 不产生任何产物变化（legacy 逐位不变）；
 *  2. structured=true → 块内必含 摘要/主张/事件流 三段，META 保留 created/updated/summary/heat
 *     （14 行索引与 auto-recall 只消费 filename+summary，改形态不影响读回）；
 *  3. 单块 UTF-8 字节数 ≤ maxBlockBytes；裁剪顺序 = heat 低者先删，同 heat 后出现者先删；
 *  4. 事件流 append-only：上一版有的事件在新版必须仍在（按行去重 + 保序）；
 *  5. legacy 块（无结构化段）升级时，正文要点进摘要、heat 进主张，原文不丢语义。
 */
import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SceneExtractor } from "../scene-extractor.js";
import { syncSceneIndex } from "../scene-index.js";
import { buildSceneExtractionPrompt } from "../../prompts/scene-extraction.js";
import type { LLMRunner } from "../../types.js";
import {
  applyStructuredForm,
  compactStructuredBlock,
  mergeAppendOnlyEvents,
  parseStructuredBlock,
  renderStructuredBlock,
  structuredByteLength,
} from "../scene-structured.js";

const dirs: string[] = [];
function makeDataDir(): string {
  const d = mkdtempSync(join(tmpdir(), "b3-scene-"));
  dirs.push(d);
  mkdirSync(join(d, "scene_blocks"), { recursive: true });
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function legacyBlock(body: string, heat = 5): string {
  return [
    "-----META-START-----",
    "created: 2026-01-01T00:00:00.000Z",
    "updated: 2026-02-02T00:00:00.000Z",
    `summary: legacy summary for structured form test`,
    `heat: ${heat}`,
    "-----META-END-----",
    "",
    body,
    "",
  ].join("\n");
}

function structuredBlock(): string {
  return renderStructuredBlock({
    meta: {
      created: "2026-01-01T00:00:00.000Z",
      updated: "2026-03-03T00:00:00.000Z",
      summary: "structured summary",
      heat: 7,
    },
    summary: "用户在 TDB 记忆系统里做 L2 分层优化。",
    claims: [
      { heat: 9, text: "高热度主张：结构化块以摘要 + 主张 + 事件流承载。" },
      { heat: 2, text: "低热度主张：这条应当最先被裁掉。" },
    ],
    events: ["2026-03-01T00:00:00.000Z | 第一次结构化写入"],
  });
}

const MEMORY = [{ content: "新增记忆", created_at: "2026-11-02T00:00:00.000Z", id: "r1" }];
function noopRunner(captured: Array<Record<string, unknown>> = []): LLMRunner {
  return {
    run: async (p: Record<string, unknown>) => {
      captured.push(p);
      return "";
    },
  } as unknown as LLMRunner;
}

describe("B3 · 结构化块渲染与解析", () => {
  it("渲染产物含 摘要/主张/事件流 三段，且 META 四字段可被既有解析读回", () => {
    const raw = structuredBlock();
    expect(raw).toContain("## 摘要");
    expect(raw).toContain("## 主张");
    expect(raw).toContain("## 事件流");
    expect(raw).toContain("-----META-START-----");

    const parsed = parseStructuredBlock(raw);
    expect(parsed.version).toBe("structured");
    expect(parsed.meta.summary).toBe("structured summary");
    expect(parsed.meta.heat).toBe(7);
    expect(parsed.claims.map((c) => c.heat)).toEqual([9, 2]);
    expect(parsed.events).toEqual(["2026-03-01T00:00:00.000Z | 第一次结构化写入"]);
  });

  it("legacy 块被识别为 legacy，并升级出摘要/主张（正文与 heat 不丢）", () => {
    const legacy = legacyBlock("## 核心叙事\n\n用户在受限网络里运维记忆系统。", 4);
    const parsed = parseStructuredBlock(legacy);
    expect(parsed.version).toBe("legacy");
    expect(parsed.meta.heat).toBe(4);
    expect(parsed.claims.length).toBeGreaterThanOrEqual(1);
    expect(parsed.summary).toContain("受限网络");
  });
});

describe("B3 · 字节上限与 heat 裁剪", () => {
  it("超长输入经 compact 后 ≤ maxBlockBytes，且先裁低 heat 主张", () => {
    const cap = 900;
    const block = renderStructuredBlock({
      meta: { created: "2026-01-01T00:00:00.000Z", updated: "2026-01-01T00:00:00.000Z", summary: "cap test", heat: 3 },
      summary: "上限压缩测试。",
      claims: [
        { heat: 9, text: "高热度：" + "甲".repeat(200) },
        { heat: 1, text: "最低热：" + "乙".repeat(200) },
        { heat: 5, text: "中热度：" + "丙".repeat(200) },
      ],
      events: ["2026-01-01T00:00:00.000Z | 事件一"],
    });
    expect(structuredByteLength(block)).toBeGreaterThan(cap);

    const compacted = compactStructuredBlock(parseStructuredBlock(block), cap);
    expect(structuredByteLength(compacted.text)).toBeLessThanOrEqual(cap);
    expect(compacted.text).toContain("高热度");
    expect(compacted.text).not.toContain("最低热");
    // 裁剪顺序：从最低 heat 起，且非递减（可裁不止一条，但绝不先裁高 heat）
    const droppedHeats = compacted.droppedClaims.map((c) => c.heat);
    expect(droppedHeats[0]).toBe(1);
    expect(droppedHeats).toEqual([...droppedHeats].sort((a, b) => a - b));
  });

  it("同 heat 时后出现者先删（稳定裁剪顺序）", () => {
    const block = renderStructuredBlock({
      meta: { created: "", updated: "", summary: "tie", heat: 1 },
      summary: "并列 heat 裁剪顺序。",
      claims: [
        { heat: 5, text: "并列第一" + "甲".repeat(150) },
        { heat: 5, text: "并列第二" + "乙".repeat(150) },
      ],
      events: [],
    });
    const cap = structuredByteLength(block) - 180;
    const compacted = compactStructuredBlock(parseStructuredBlock(block), cap);
    expect(compacted.text).toContain("并列第一");
    expect(compacted.text).not.toContain("并列第二");
  });

  it("空块/零主张 + 极小上限不抛错（退化为裁剪摘要）", () => {
    const tiny = renderStructuredBlock({
      meta: { created: "", updated: "", summary: "", heat: 0 },
      summary: "长".repeat(500),
      claims: [],
      events: [],
    });
    // 可压到 200 字节：主张/事件都空 ⇒ 只能截摘要
    const compacted = compactStructuredBlock(parseStructuredBlock(tiny), 200);
    expect(structuredByteLength(compacted.text)).toBeLessThanOrEqual(200);
    expect(compacted.text.startsWith("-----META-START-----")).toBe(true);

    // 上限低于 META+三段标题骨架（约 136 字节）时：以骨架为准，不抛错、META 完整
    const belowSkeleton = compactStructuredBlock(parseStructuredBlock(tiny), 50);
    expect(belowSkeleton.text.startsWith("-----META-START-----")).toBe(true);
    expect(belowSkeleton.text).toContain("-----META-END-----");
    expect(structuredByteLength(belowSkeleton.text)).toBeLessThan(structuredByteLength(compacted.text));
  });
});

describe("F8 · META heat 越界归一（2026-11-02 复验，F9 改为十进制尺度折算）", () => {
  it("META heat=74（生产实测越界值）按十进制尺度折算为 7，索引 heat 同值", () => {
    const raw = renderStructuredBlock({
      meta: { created: "", updated: "", summary: "heat clamp", heat: 74 },
      summary: "越界 heat 归一测试。",
      claims: [],
      events: [],
    });
    expect(raw).toContain("heat: 7");
    expect(raw).not.toContain("heat: 74");
    expect(parseStructuredBlock(raw).meta.heat).toBe(7);
  });

  it("主张 heat 越界同样按尺度折算（74 → 7），负值仍落 0", () => {
    const raw = renderStructuredBlock({
      meta: { created: "", updated: "", summary: "claim heat", heat: 5 },
      summary: "主张 heat 归一。",
      claims: [
        { heat: 74, text: "越界主张" },
        { heat: -3, text: "负值主张" },
      ],
      events: [],
    });
    const heats = parseStructuredBlock(raw).claims.map((c) => c.heat);
    expect(heats).toEqual([7, 0]);
  });

  it("compact 的字节上限不被 heat 上界污染（4096 仍按 4096 裁）", () => {
    const block = renderStructuredBlock({
      meta: { created: "", updated: "", summary: "cap not clamped", heat: 4 },
      summary: "字节上限独立性。",
      claims: [{ heat: 9, text: "甲".repeat(1200) }],
      events: [],
    });
    const compacted = compactStructuredBlock(parseStructuredBlock(block), 4096);
    expect(compacted.droppedClaims).toHaveLength(0);
    expect(structuredByteLength(compacted.text)).toBeGreaterThan(1000);
  });
});

describe("F8 · 事件流近义合并（2026-11-02 复验）", () => {
  it("仅标点/空白/大小写不同视为同一条：保留首条原文，新事件追加在后", () => {
    const merged = mergeAppendOnlyEvents(
      ["2026-01-01 | 部署完成。"],
      ["2026-01-01 |  部署完成", "2026-01-02 | 开始回归", "2026-01-02 | 开始回归！"],
    );
    expect(merged).toEqual(["2026-01-01 | 部署完成。", "2026-01-02 | 开始回归"]);
  });

  it("语义不同的事件不会被误合并", () => {
    const merged = mergeAppendOnlyEvents([], ["部署完成", "部署失败", "部署完成但超时"]);
    expect(merged).toHaveLength(3);
  });
});

describe("B3 · 事件流 append-only", () => {
  it("历史事件保序保留，新事件追加在后，重复行去重", () => {
    const merged = mergeAppendOnlyEvents(["2026-01-01 | a", "2026-01-02 | b"], ["2026-01-02 | b", "2026-01-03 | c"]);
    expect(merged).toEqual(["2026-01-01 | a", "2026-01-02 | b", "2026-01-03 | c"]);
  });

  it("第二次写入不清空历史事件段", () => {
    const first = structuredBlock();
    const second = renderStructuredBlock({
      meta: { created: "2026-01-01T00:00:00.000Z", updated: "2026-04-04T00:00:00.000Z", summary: "second", heat: 8 },
      summary: "第二轮写入。",
      claims: [{ heat: 9, text: "第二轮主张" }],
      events: ["2026-04-01T00:00:00.000Z | 第二次结构化写入"],
    });
    const merged = applyStructuredForm({ raw: second, previousRaw: first, maxBlockBytes: 4096 });
    expect(merged).toContain("第一次结构化写入");
    expect(merged).toContain("第二次结构化写入");
  });
});

describe("B3 · 抽取器接线（fake LLM，零真调用）", () => {
  it("l2Form.structured=false（缺省）→ 场景块逐位不变", async () => {
    const dataDir = makeDataDir();
    const original = legacyBlock("## 核心叙事\n\n原样保留。", 3);
    writeFileSync(join(dataDir, "scene_blocks", "Legacy.md"), original, "utf-8");
    await syncSceneIndex(dataDir);

    const ex = new SceneExtractor({ dataDir, maxScenes: 15, llmRunner: noopRunner() });
    await ex.extract(MEMORY);

    expect(readFileSync(join(dataDir, "scene_blocks", "Legacy.md"), "utf-8")).toBe(original);
  });

  it("l2Form.structured=true → legacy 块升级为结构化且 ≤ maxBlockBytes，索引 summary 仍可读", async () => {
    const dataDir = makeDataDir();
    writeFileSync(join(dataDir, "scene_blocks", "Legacy.md"), legacyBlock("## 核心叙事\n\n正文要点。", 6), "utf-8");
    await syncSceneIndex(dataDir);

    const ex = new SceneExtractor({
      dataDir,
      maxScenes: 15,
      llmRunner: noopRunner(),
      l2Form: { structured: true, maxBlockBytes: 4096 },
    });
    await ex.extract(MEMORY);

    const raw = readFileSync(join(dataDir, "scene_blocks", "Legacy.md"), "utf-8");
    expect(raw).toContain("## 主张");
    expect(raw).toContain("## 事件流");
    expect(structuredByteLength(raw)).toBeLessThanOrEqual(4096);

    const idx = JSON.parse(readFileSync(join(dataDir, ".metadata", "scene_index.json"), "utf-8"));
    expect(idx.length).toBe(1);
    expect(idx[0].filename).toBe("Legacy.md");
    expect(idx[0].heat).toBe(6);
    expect(typeof idx[0].summary).toBe("string");
    expect(idx[0].summary.length).toBeGreaterThan(0);
  });

  it("structured=true 时 prompt 追加结构化格式要求；structured=false 时逐位不变", () => {
    const base = {
      memoriesJson: "[]",
      sceneSummaries: "(无已有场景)",
      currentTimestamp: "2026-11-02T00:00:00.000Z",
      maxScenes: 15,
    };
    const legacyA = buildSceneExtractionPrompt(base);
    const legacyB = buildSceneExtractionPrompt({ ...base, structuredForm: { enabled: false, maxBlockBytes: 4096 } });
    expect(legacyB.userPrompt).toBe(legacyA.userPrompt);
    expect(legacyB.systemPrompt).toBe(legacyA.systemPrompt);

    const structured = buildSceneExtractionPrompt({ ...base, structuredForm: { enabled: true, maxBlockBytes: 2048 } });
    expect(structured.userPrompt).not.toBe(legacyA.userPrompt);
    expect(structured.userPrompt).toContain("## 主张");
    expect(structured.userPrompt).toContain("事件流");
    expect(structured.userPrompt).toContain("2048");
  });
});

describe("F9 · heat 十进制尺度归一（0-10 原样，越界按十进制折算）", () => {
  const cases: Array<[unknown, number]> = [
    [0, 0],
    [3, 3],
    [10, 10],
    [11, 1],
    [74, 7],
    [100, 10],
    [315, 3],
    [-5, 0],
  ];

  it.each(cases)("claim heat %s 归一为 %s（渲染 + 解析闭环）", (input, expected) => {
    const raw = renderStructuredBlock({
      meta: { created: "", updated: "", summary: "heat scale", heat: 5 },
      summary: "heat 尺度归一。",
      claims: [{ heat: input as number, text: "尺度主张" }],
      events: [],
    });
    expect(parseStructuredBlock(raw).claims.map((c) => c.heat)).toEqual([expected]);
  });

  it('字符串 "7" 按数字 7 处理，非法串落 0', () => {
    const raw = renderStructuredBlock({
      meta: { created: "", updated: "", summary: "heat strings", heat: "abc" as unknown as number },
      summary: "字符串 heat。",
      claims: [{ heat: "7" as unknown as number, text: "字符串 heat 主张" }],
      events: [],
    });
    expect(parseStructuredBlock(raw).claims.map((c) => c.heat)).toEqual([7]);
    const metaLine = raw.split("\n").find((line) => line.startsWith("heat: "));
    expect(metaLine).toBe("heat: 0");
  });

  it("落盘 heat 恒为 0..10 的非负整数（含大量越界输入）", () => {
    const raw = renderStructuredBlock({
      meta: { created: "", updated: "", summary: "range", heat: 1000 },
      summary: "值域断言。",
      claims: [11, 74, 100, -3, 9].map((heat, i) => ({ heat, text: "主张" + i })),
      events: [],
    });
    const parsed = parseStructuredBlock(raw);
    for (const heat of [parsed.meta.heat, ...parsed.claims.map((c) => c.heat)]) {
      expect(Number.isInteger(heat)).toBe(true);
      expect(heat).toBeGreaterThanOrEqual(0);
      expect(heat).toBeLessThanOrEqual(10);
    }
  });
});

describe("F9 · 主张派生兜底（claims 段不再恒空）", () => {
  it("结构化块 0 条主张但有摘要：按句派生 1-3 条带 heat 主张", () => {
    const raw = renderStructuredBlock({
      meta: { created: "", updated: "", summary: "派生兜底", heat: 8 },
      summary: "甲句一。乙句二！丙句三？丁句四。",
      claims: [],
      events: [],
    });
    const parsed = parseStructuredBlock(raw);
    expect(parsed.claims.map((c) => c.text)).toEqual(["甲句一", "乙句二", "丙句三"]);
    expect(parsed.claims.map((c) => c.heat)).toEqual([8, 8, 8]);
  });

  it("段摘要为空时用 META summary 派生（META summary 是索引的既有摘要面）", () => {
    const raw = renderStructuredBlock({
      meta: { created: "", updated: "", summary: "META 摘要句一。META 摘要句二。", heat: 6 },
      summary: "",
      claims: [],
      events: [],
    });
    expect(parseStructuredBlock(raw).claims.map((c) => c.text)).toEqual(["META 摘要句一", "META 摘要句二"]);
  });

  it("纯标题段不算内容：无摘要/事件时仍 0 主张", () => {
    const raw = renderStructuredBlock({
      meta: { created: "", updated: "", summary: "", heat: 4 },
      summary: "## 仅标题",
      claims: [],
      events: [],
    });
    expect(parseStructuredBlock(raw).claims).toEqual([]);
  });

  it("只有事件没有摘要时派生出 1 条主张（取最后一条事件描述）", () => {
    const raw = renderStructuredBlock({
      meta: { created: "", updated: "", summary: "", heat: 5 },
      summary: "",
      claims: [],
      events: ["2026-01-01T00:00:00Z | 第一条事件", "2026-01-02T00:00:00Z | 第二条事件"],
    });
    const parsed = parseStructuredBlock(raw);
    expect(parsed.claims.map((c) => c.text)).toEqual(["第二条事件"]);
    expect(parsed.claims[0]!.heat).toBe(5);
  });
});

describe("F9 · 事件同源改写去重与时间序", () => {
  it("同时间戳 + 规范化高度重合（Dice ≥ 0.6）判同源改写，保留信息更全的一条", () => {
    const merged = mergeAppendOnlyEvents(
      [],
      [
        "2026-10-23T06:12:12Z | 部署完成：4 文件 +144/−10，未 push，临时日志删净。",
        "2026-10-23T06:12:12Z | 部署完成，恰 4 文件 +144/−10，未 push、临时日志删净、外来未跟踪文件未裹挟。",
      ],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toContain("外来未跟踪文件未裹挟");
  });

  it("同时间戳但重合低于阈值（同主题不同事实）保留两条，不做语义合并", () => {
    const merged = mergeAppendOnlyEvents(
      [],
      [
        "2026-10-23T09:18:02Z | #89 TDD 全链：RED 12 用例（acp-tag 7 单测＋recorder 5）均因正确原因失败；GREEN 新建 acp-tag.ts 与 recorder 五处剥后入库；定向 16/16、全量门四绿。",
        "2026-10-23T09:18:02Z | #89 合同与门禁：票面含根因行号/探针数据/五点定案/RED 8 例合同；RED 12 用例均因正确原因失败，GREEN 后定向 16/16、全量门四绿。",
      ],
    );
    expect(merged).toHaveLength(2);
  });

  it("输出按时间升序；解析不到时间的事件稳定保持插入序并排在末尾", () => {
    const merged = mergeAppendOnlyEvents(
      [],
      ["无时间戳甲", "2026-03-03T00:00:00Z | 第三条", "无时间戳乙", "2026-01-01T00:00:00Z | 第一条"],
    );
    expect(merged).toEqual([
      "2026-01-01T00:00:00Z | 第一条",
      "2026-03-03T00:00:00Z | 第三条",
      "无时间戳甲",
      "无时间戳乙",
    ]);
  });
});

describe("F9 · 生产形态与旧行为锁定", () => {
  it("生产块（heat 越界 + claims 空 + 事件乱序含同时间戳改写）一次 apply 后形态正确且幂等", () => {
    const raw = renderStructuredBlock({
      meta: {
        created: "2026-10-20T00:00:00.000Z",
        updated: "2026-11-02T10:21:51.829Z",
        summary: "生产形态",
        heat: 315,
      },
      summary: "第一句事实。第二句事实！第三句事实？第四句事实。",
      claims: [],
      events: [
        "2026-10-23T09:18:02Z | #89 TDD 全链：RED 12 用例均因正确原因失败；GREEN 新建 acp-tag.ts 与 recorder 五处剥后入库；定向 16/16、全量门四绿。",
        "2026-10-23T06:12:12Z | 部署完成：4 文件 +144/−10，未 push，临时日志删净。",
        "2026-10-23T09:18:02Z | #89 TDD 全链：RED 12 用例均因正确原因失败；GREEN 新建 acp-tag.ts、recorder 五处剥后入库；定向 16/16、全量门四绿、票评留档。",
        "2026-10-23T06:12:12Z | 部署完成，恰 4 文件 +144/−10，未 push、临时日志删净、外来未跟踪文件未裹挟。",
      ],
    });

    const first = applyStructuredForm({ raw, maxBlockBytes: 4096 });
    const parsed = parseStructuredBlock(first);
    expect(parsed.meta.heat).toBe(3);
    expect(parsed.meta.created).toBe("2026-10-20T00:00:00.000Z");
    expect(parsed.summary).toContain("第一句事实");
    expect(parsed.claims.length).toBeGreaterThanOrEqual(1);
    expect(parsed.claims.length).toBeLessThanOrEqual(3);
    expect(parsed.events).toHaveLength(2);
    expect(parsed.events[0]).toContain("2026-10-23T06:12:12Z");
    expect(parsed.events[0]).toContain("外来未跟踪文件未裹挟");
    expect(parsed.events[1]).toContain("2026-10-23T09:18:02Z");
    expect(parsed.events[1]).toContain("票评留档");
    expect(structuredByteLength(first)).toBeLessThanOrEqual(4096);

    const second = applyStructuredForm({ raw: first, maxBlockBytes: 4096 });
    expect(second).toBe(first);
    expect(parseStructuredBlock(renderStructuredBlock(parsed))).toEqual(parsed);
  });

  it("裁剪顺序锁定：先裁 heat 最低主张，主张裁光后再从最旧事件丢", () => {
    const block = renderStructuredBlock({
      meta: { created: "2026-01-01T00:00:00.000Z", updated: "2026-02-02T00:00:00.000Z", summary: "裁剪顺序", heat: 5 },
      summary: "裁剪顺序测试。",
      claims: [
        { heat: 9, text: "高热主张：" + "甲".repeat(80) },
        { heat: 1, text: "低热主张：" + "乙".repeat(80) },
      ],
      events: [
        "2026-01-01T00:00:00Z | 最旧事件：" + "丙".repeat(80),
        "2026-01-02T00:00:00Z | 中间事件：" + "丁".repeat(80),
        "2026-01-03T00:00:00Z | 最新事件：" + "戊".repeat(80),
      ],
    });
    const parsed = parseStructuredBlock(block);
    // 上限定在「主张全裁光仍超限」的位置：先按 heat 升序裁光主张，再从最旧事件丢。
    const cap = structuredByteLength(block) - 600;
    const compacted = compactStructuredBlock(parsed, cap);
    expect(compacted.droppedClaims.map((c) => c.heat)).toEqual([1, 9]);
    expect(compacted.droppedEvents[0]).toContain("最旧事件");
    expect(compacted.text).toContain("最新事件");
    expect(compacted.text).not.toContain("低热主张");
    expect(compacted.text).not.toContain("高热主张");
    expect(structuredByteLength(compacted.text)).toBeLessThanOrEqual(cap);
  });

  it("META 完整性优先：极小上限下四字段与分隔符仍在（只截摘要）", () => {
    const block = renderStructuredBlock({
      meta: {
        created: "2026-01-01T00:00:00.000Z",
        updated: "2026-02-02T00:00:00.000Z",
        summary: "META 必须完整",
        heat: 4,
      },
      summary: "很长的摘要文本。".repeat(40),
      claims: [{ heat: 9, text: "会被裁掉的主张" }],
      events: ["2026-01-01T00:00:00Z | 会被丢掉的事件"],
    });
    const compacted = compactStructuredBlock(parseStructuredBlock(block), 60);
    expect(compacted.text).toContain("-----META-START-----");
    expect(compacted.text).toContain("created: 2026-01-01T00:00:00.000Z");
    expect(compacted.text).toContain("updated: 2026-02-02T00:00:00.000Z");
    expect(compacted.text).toContain("summary: ");
    expect(compacted.text).toContain("heat: 4");
    expect(compacted.text).toContain("-----META-END-----");
  });

  it("legacy 升级路径锁定：段落升主张、heat 走同一尺度归一且内容 parse(render) 幂等", () => {
    const legacy = legacyBlock("## 核心叙事\n\n第一段正文。\n\n第二段正文。", 315);
    const parsed = parseStructuredBlock(legacy);
    expect(parsed.version).toBe("legacy");
    expect(parsed.claims.length).toBeGreaterThanOrEqual(1);
    expect(parsed.claims.every((c) => c.heat === 3)).toBe(true);
    // version 由 legacy 升为 structured 是升级的预期结果；内容面必须幂等。
    const rerendered = parseStructuredBlock(renderStructuredBlock(parsed));
    expect(rerendered.version).toBe("structured");
    expect(rerendered.meta).toEqual(parsed.meta);
    expect(rerendered.summary).toBe(parsed.summary);
    expect(rerendered.claims).toEqual(parsed.claims);
    expect(rerendered.events).toEqual(parsed.events);
    // 已是 structured 后再走一轮 render→parse，逐字段完全稳定。
    expect(parseStructuredBlock(renderStructuredBlock(rerendered))).toEqual(rerendered);
  });
});
