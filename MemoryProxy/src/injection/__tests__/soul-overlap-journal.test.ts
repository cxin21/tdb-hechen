/**
 * #26（R5）：soul/core 重叠观测 journal 单测。
 * 合同：r5-26.md —— journal 字段落地零行为变化（纯观测，不改注入字节）；
 * 预注册决策规则三档（>80 归一 / 60-80 分工 / <60 维持）在报告脚本侧落地。
 */

import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fnv1a32,
  extractSoulCore,
  lineHashes,
  jaccard,
  buildJournalEntry,
  appendJournalEntry,
  JOURNAL_NORM_VERSION,
  journalNormVersion,
  type SoulOverlapJournalEntry,
} from "../soul-overlap-journal.js";
import {
  CompositeInjectionObserver,
  SoulOverlapJournalObserver,
} from "../soul-overlap-journal-observer.js";
import type { AgentContextMetadata, ContextBlock } from "../types.js";
import type { HookResult, InjectionObserver } from "../observer.js";

const SOUL_BLOCK: ContextBlock = {
  type: "system" as ContextBlock["type"],
  content:
    "<soul-identity>\n## 此刻的你\n（我是谁）- [self_identity] - 工程纪律。\n</soul-identity>\n\n<soul-feeling>\n## 当下的感受\n驱动我行动的价值：根因。\n</soul-feeling>",
} as ContextBlock;

const CORE_BLOCK: ContextBlock = {
  type: "system" as ContextBlock["type"],
  content:
    "<tdai_profile_memory>\n# User Narrative Profile\n长期偏好：test-gated TDD。\n</tdai_profile_memory>",
} as ContextBlock;

const NOISE_BLOCK: ContextBlock = {
  type: "system" as ContextBlock["type"],
  content: "<skill_tools>无关注入</skill_tools>",
} as ContextBlock;

function meta(sessionKey: string, turnSeq: number): AgentContextMetadata {
  return { sessionKey, turnSeq } as unknown as AgentContextMetadata;
}

describe("fnv1a32（与 MemoryCore soul-assembler 同算法）", () => {
  it("已知向量：'a' → e40c292c，'' → 811c9dc5", () => {
    expect(fnv1a32("a")).toBe("e40c292c");
    expect(fnv1a32("")).toBe("811c9dc5");
  });

  it("输出 8 位 hex", () => {
    expect(fnv1a32("灵魂注入")).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("extractSoulCore", () => {
  it("跨块聚合 soul-identity + soul-feeling + tdai_profile_memory，忽略无关块", () => {
    const out = extractSoulCore([NOISE_BLOCK, SOUL_BLOCK, CORE_BLOCK]);
    expect(out).not.toBeNull();
    expect(out!.soul).toContain("<soul-identity>");
    expect(out!.soul).toContain("<soul-feeling>");
    expect(out!.core).toContain("<tdai_profile_memory>");
    expect(out!.core).not.toContain("soul-identity");
    expect(out!.soul).not.toContain("skill_tools");
  });

  it("两者皆空返回 null", () => {
    expect(extractSoulCore([NOISE_BLOCK])).toBeNull();
    expect(extractSoulCore([])).toBeNull();
    expect(extractSoulCore(undefined as unknown as ContextBlock[])).toBeNull();
  });

  it("只有 core 也返回条目（soul='' 合法）", () => {
    const out = extractSoulCore([CORE_BLOCK]);
    expect(out).not.toBeNull();
    expect(out!.soul).toBe("");
    expect(out!.core.length).toBeGreaterThan(0);
  });
});

describe("lineHashes / jaccard", () => {
  it("空行剔除、逐行稳定", () => {
    const h1 = lineHashes("aaa\n\nbbb\n");
    const h2 = lineHashes("aaa\n\nbbb\n");
    expect(h1).toEqual(h2);
    expect(h1).toHaveLength(2);
  });

  it("H26 归一化：soul 包装行与 core 裸行同 hash（同文异装不再恒 0 重叠）", () => {
    const soulLine = "（我是谁）- [self_identity] - 排查坚持源码考古与最小探针。";
    const strictLine = "- [strict_rule] - 绝不通过任何路径删除记忆。";
    const coreBare = "排查坚持源码考古与最小探针。";
    const coreList = "- 绝不通过任何路径删除记忆。";
    const hs = lineHashes(soulLine);
    const hc = lineHashes(coreBare);
    expect(hs).toEqual(hc);
    expect(lineHashes(strictLine)).toEqual(lineHashes(coreList));
  });

  it("H26 归一化：真异文仍不同 hash（归一不吞差异）", () => {
    const a = lineHashes("（我是谁）- [self_identity] - 内容甲");
    const b = lineHashes("（我是谁）- [self_identity] - 内容乙");
    expect(a).not.toEqual(b);
    // 非 slot 行（如价值锚行）不受影响
    expect(lineHashes("一手证据(趋近)：先亲跑测试。")).not.toEqual(lineHashes("一手证据(审慎)：先亲跑测试。"));
  });

  it("Jaccard 边界：相同=1、不相交=0、部分重叠=1/3、双空=0", () => {
    const a = lineHashes("x\ny");
    const b = lineHashes("x\ny");
    const c = lineHashes("p\nq");
    const d = lineHashes("x\nz");
    expect(jaccard(a, b)).toBe(1);
    expect(jaccard(a, c)).toBe(0);
    expect(jaccard(a, d)).toBeCloseTo(1 / 3, 6);
    expect(jaccard([], [])).toBe(0);
  });
});

describe("buildJournalEntry", () => {
  it("全字段落地：chars/hash/line_hashes/session/turn_seq", () => {
    const now = new Date("2026-10-16T04:00:00.000Z");
    const entry = buildJournalEntry([SOUL_BLOCK, CORE_BLOCK], meta("sess-1", 7), now)!;
    expect(entry.ts).toBe("2026-10-16T04:00:00.000Z");
    expect(entry.session).toBe("sess-1");
    expect(entry.turn_seq).toBe(7);
    expect(entry.soul_chars).toBe(extractSoulCore([SOUL_BLOCK])!.soul.length);
    expect(entry.core_chars).toBe(extractSoulCore([CORE_BLOCK])!.core.length);
    expect(entry.soul_hash).toBe(fnv1a32(extractSoulCore([SOUL_BLOCK])!.soul));
    expect(entry.core_hash).toBe(fnv1a32(extractSoulCore([CORE_BLOCK])!.core));
    expect(entry.soul_line_hashes.length).toBeGreaterThan(0);
    expect(entry.core_line_hashes.length).toBeGreaterThan(0);
  });

  it("meta 缺失 → session=unknown、turn_seq=-1；无材料 → null", () => {
    const e = buildJournalEntry([CORE_BLOCK], undefined)!;
    expect(e.session).toBe("unknown");
    expect(e.turn_seq).toBe(-1);
    expect(buildJournalEntry([NOISE_BLOCK], meta("s", 1))).toBeNull();
  });
});

describe("appendJournalEntry", () => {
  it("JSONL 追加写（自动建目录、一行一条）", () => {
    const dir = mkdtempSync(join(tmpdir(), "soul-journal-"));
    const file = join(dir, "nested", "journal.jsonl");
    const entry = buildJournalEntry([SOUL_BLOCK, CORE_BLOCK], meta("s", 1))!;
    appendJournalEntry(file, entry);
    appendJournalEntry(file, entry);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const parsed = JSON.parse(lines[0]) as SoulOverlapJournalEntry;
    expect(parsed.session).toBe("s");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("SoulOverlapJournalObserver（跨钩子聚合、单轮单行）", () => {
  function flushObserver(file: string): SoulOverlapJournalObserver {
    return new SoulOverlapJournalObserver({ enabled: true, file });
  }

  it("start → soul 钩子 → core 钩子 → end 落一行", () => {
    const dir = mkdtempSync(join(tmpdir(), "soul-obs-"));
    const file = join(dir, "j.jsonl");
    const obs = flushObserver(file);
    obs.onPipelineStart(meta("sess", 3));
    obs.onHookDone({} as never, "system" as never, [SOUL_BLOCK], 1);
    obs.onHookDone({} as never, "system" as never, [CORE_BLOCK], 1);
    obs.onPipelineEnd(meta("sess", 3), 10, []);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as SoulOverlapJournalEntry;
    expect(parsed.session).toBe("sess");
    expect(parsed.turn_seq).toBe(3);
    expect(parsed.soul_chars).toBeGreaterThan(0);
    expect(parsed.core_chars).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("无 soul/core 材料的轮不落行；错误轮丢弃", () => {
    const dir = mkdtempSync(join(tmpdir(), "soul-obs-"));
    const file = join(dir, "j.jsonl");
    const obs = flushObserver(file);
    obs.onPipelineStart(meta("sess", 1));
    obs.onHookDone({} as never, "system" as never, [NOISE_BLOCK], 1);
    obs.onPipelineEnd(meta("sess", 1), 5, []);
    obs.onPipelineStart(meta("sess", 2));
    obs.onHookDone({} as never, "system" as never, [CORE_BLOCK], 1);
    obs.onPipelineError(meta("sess", 2), new Error("boom"));
    // 零材料轮与错误轮都不落行——journal 从不创建空文件
    expect(existsSync(file)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("并发双轮：hookDone 挂靠被保守丢弃（不串轮污染），轮空落盘", () => {
    const dir = mkdtempSync(join(tmpdir(), "soul-obs-"));
    const file = join(dir, "j.jsonl");
    const obs = flushObserver(file);
    obs.onPipelineStart(meta("a", 1));
    obs.onPipelineStart(meta("b", 1)); // 第二轮开始 → 两个活跃 buffer
    obs.onHookDone({} as never, "system" as never, [CORE_BLOCK], 1); // 保守丢弃
    obs.onPipelineEnd(meta("a", 1), 1, []);
    obs.onPipelineEnd(meta("b", 1), 1, []);
    // 保守丢弃：两活跃 buffer 期间 hookDone 不挂靠、双轮均无材料 → 不落盘
    expect(existsSync(file)).toBe(false);
    // R5-F2：丢弃可见性——droppedCount 计到 1
    expect(obs.droppedCount).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("同 turnKey 二次 start：复用而非覆盖，已聚合块不丢（R5-F2b）", () => {
    const dir = mkdtempSync(join(tmpdir(), "soul-obs-"));
    const file = join(dir, "j.jsonl");
    const obs = flushObserver(file);
    obs.onPipelineStart(meta("sess", 1));
    obs.onHookDone({} as never, "system" as never, [SOUL_BLOCK], 1);
    obs.onPipelineStart(meta("sess", 1)); // 同键二次 start（工具循环/并发场景）
    obs.onHookDone({} as never, "system" as never, [CORE_BLOCK], 1);
    obs.onPipelineEnd(meta("sess", 1), 1, []);
    expect(existsSync(file)).toBe(true); // soul+core 都聚合到同一 buffer，正常落盘
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { soul_chars: number; core_chars: number };
    expect(parsed.soul_chars).toBeGreaterThan(0);
    expect(parsed.core_chars).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("observer 异常永不传播：写盘失败静默", () => {
    const obs = new SoulOverlapJournalObserver({
      enabled: true,
      file: "Z:\\definitely\\not\\writable\\j.jsonl",
    });
    obs.onPipelineStart(meta("s", 1));
    obs.onHookDone({} as never, "system" as never, [CORE_BLOCK], 1);
    expect(() => obs.onPipelineEnd(meta("s", 1), 1, [])).not.toThrow();
  });
});

describe("CompositeInjectionObserver", () => {
  it("全部方法委托；子 observer 抛异常被隔离，兄弟仍被调用", () => {
    const calls: string[] = [];
    const bad: InjectionObserver = {
      onPipelineStart: () => { throw new Error("bad"); },
      onPipelineEnd: () => { throw new Error("bad"); },
      onPipelineError: () => { throw new Error("bad"); },
      onHookStart: () => { throw new Error("bad"); },
      onHookDone: () => { throw new Error("bad"); },
      onHookError: () => { throw new Error("bad"); },
    };
    const good: InjectionObserver = {
      onPipelineStart: () => calls.push("start"),
      onPipelineEnd: () => calls.push("end"),
      onPipelineError: () => calls.push("error"),
      onHookStart: () => calls.push("hookStart"),
      onHookDone: () => calls.push("hookDone"),
      onHookError: () => calls.push("hookError"),
    };
    const comp = new CompositeInjectionObserver([bad, good]);
    const m = meta("s", 1);
    comp.onPipelineStart(m);
    comp.onHookDone({} as never, "system" as never, [], 1);
    comp.onPipelineEnd(m, 1, [] as HookResult[]);
    comp.onHookStart({} as never, "system" as never);
    comp.onHookError({} as never, "system" as never, new Error("x"), 1);
    comp.onPipelineError(m, new Error("x"));
    expect(calls).toEqual(["start", "hookDone", "end", "hookStart", "hookError", "error"]);
  });
});

describe("#38 请求级 requestId 路由（turnKey 碰撞根修）", () => {
  function reqMeta(sessionKey: string, turnSeq: number, requestId: string): AgentContextMetadata {
    return { sessionKey, turnSeq, requestId } as unknown as AgentContextMetadata;
  }

  it("同 sessionKey:turnSeq 不同 requestId → 两行落盘互不污染（onHookDone 直达路由）", () => {
    const dir = mkdtempSync(join(tmpdir(), "soul-journal-req-"));
    const file = join(dir, "journal.jsonl");
    const obs = new SoulOverlapJournalObserver({ enabled: true, file });
    const mA = reqMeta("sess", 1, "req-A");
    const mB = reqMeta("sess", 1, "req-B");
    obs.onPipelineStart(mA);
    obs.onPipelineStart(mB); // 同 legacy 键并发——requestId 键不碰撞
    obs.onHookDone({} as never, "system" as never, [SOUL_BLOCK], 1, undefined, "req-A");
    obs.onHookDone({} as never, "system" as never, [CORE_BLOCK], 1, undefined, "req-B");
    obs.onPipelineEnd(mA, 5, [] as HookResult[]);
    obs.onPipelineEnd(mB, 5, [] as HookResult[]);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const entries = lines.map((l) => JSON.parse(l) as { soul_chars: number; core_chars: number });
    const soulLine = entries.find((e) => e.soul_chars > 0);
    const coreLine = entries.find((e) => e.core_chars > 0);
    expect(soulLine).toBeDefined();
    expect(coreLine).toBeDefined();
    expect(soulLine!.core_chars).toBe(0); // A 行只含 soul 块
    expect(coreLine!.soul_chars).toBe(0); // B 行只含 core 块
    rmSync(dir, { recursive: true, force: true });
  });

  it("多活跃 buffer 下 onHookDone 带 requestId 直达，不触发保守丢弃", () => {
    const dir = mkdtempSync(join(tmpdir(), "soul-journal-req2-"));
    const file = join(dir, "journal.jsonl");
    const obs = new SoulOverlapJournalObserver({ enabled: true, file });
    obs.onPipelineStart(reqMeta("a", 1, "r1"));
    obs.onPipelineStart(reqMeta("b", 1, "r2"));
    obs.onHookDone({} as never, "system" as never, [CORE_BLOCK], 1, undefined, "r2");
    obs.onPipelineEnd(reqMeta("a", 1, "r1"), 1, [] as HookResult[]); // r1 空 buffer → 不落盘
    obs.onPipelineEnd(reqMeta("b", 1, "r2"), 1, [] as HookResult[]);
    expect(obs.droppedCount).toBe(0);
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { core_chars: number };
    expect(parsed.core_chars).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("requestId 缺省回退 legacy 键（现有行为不变）", () => {
    const dir = mkdtempSync(join(tmpdir(), "soul-journal-legacy-"));
    const file = join(dir, "journal.jsonl");
    const obs = new SoulOverlapJournalObserver({ enabled: true, file });
    obs.onPipelineStart(meta("s", 1));
    obs.onHookDone({} as never, "system" as never, [CORE_BLOCK], 1);
    obs.onPipelineEnd(meta("s", 1), 1, [] as HookResult[]);
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { core_chars: number };
    expect(parsed.core_chars).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("#51 norm 口径版本（H26 归一化切换窗）", () => {
  it("buildJournalEntry 新行带 norm=JOURNAL_NORM_VERSION（当前=1）", () => {
    const entry = buildJournalEntry([SOUL_BLOCK, CORE_BLOCK], meta("s", 1))!;
    expect(entry.norm).toBe(1);
    expect(entry.norm).toBe(JOURNAL_NORM_VERSION);
  });

  it("appendJournalEntry JSONL roundtrip 保留 norm 字段", () => {
    const dir = mkdtempSync(join(tmpdir(), "soul-journal-norm-"));
    const file = join(dir, "j.jsonl");
    appendJournalEntry(file, buildJournalEntry([SOUL_BLOCK, CORE_BLOCK], meta("s", 1))!);
    const parsed = JSON.parse(readFileSync(file, "utf8").trim()) as SoulOverlapJournalEntry;
    expect(parsed.norm).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("journalNormVersion：缺省/undefined/NaN/非数字 → 0（旧口径），1 → 1", () => {
    expect(journalNormVersion({})).toBe(0);
    expect(journalNormVersion(undefined)).toBe(0);
    expect(journalNormVersion({ norm: undefined })).toBe(0);
    expect(journalNormVersion({ norm: Number.NaN })).toBe(0);
    expect(journalNormVersion({ norm: "1" as unknown as number })).toBe(0);
    expect(journalNormVersion({ norm: 1 })).toBe(1);
  });

  it("旧行（无 norm 字段）JSONL 解析不炸 = 0 口径（向后兼容）", () => {
    const oldLine =
      '{"ts":"2026-10-16T01:00:00.000Z","session":"s","turn_seq":1,"soul_chars":10,"core_chars":20,' +
      '"soul_hash":"aa","core_hash":"bb","soul_line_hashes":["x"],"core_line_hashes":["y"]}';
    const old = JSON.parse(oldLine) as SoulOverlapJournalEntry;
    expect(old.session).toBe("s");
    expect(journalNormVersion(old)).toBe(0);
  });
});
