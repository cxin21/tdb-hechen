/**
 * V6-1a（2026-09-23 用户授权「严格自审通过即开工」）：属性信号徽章 + 三构造点透传测试。
 * RED 先行：徽章与透传用例改前全 failed（D-3 丢值点④⑥ / F-R12 同族——漏一个=徽章单通道）。
 * 逐位现状对照（守卫用例，改前改后都必须绿）：字段缺省 → 输出逐字节不变。
 * 徽章设计（设计小节 D-V6-1a 呈报 + 用户授权自审定案）：
 *   ·强烈      arousal ≥ 0.7（生产基数 10 行）
 *   ·验证×N    recallCount ≥ 3（基数 225 行）
 *   ·核心事实  identityRefs 非空（基数 141 行）
 *   ·已演化    evolution 存在（基数 0 行——休眠保留）
 *   ·自 date 起 valid_start 非空（基数 208 行；日期精度与「发生」同 slice(0,10)）
 */
import { describe, it, expect } from "vitest";
import {
  formatMemoryLine,
  vectorResultToFormatable,
  ftsResultToFormatable,
  recordToFormatable,
  MEMORY_LINE_RE,
} from "../auto-recall.js";

/** soul[] 族解析（族分隔符 " · "，首项无前缀点——与敏感/周期徽章同族格式）。 */
const soulItems = (line: string): string[] => {
  const m = line.match(/·soul\[([^\]]*)\]/);
  return m ? m[1].split(" · ") : [];
};

describe("formatMemoryLine 属性信号徽章（V6-1a）", () => {
  it("arousal ≥ 0.7 → ·强烈（阈值边界含等号）", () => {
    expect(soulItems(formatMemoryLine({ type: "episodic", content: "x", arousal: 0.7 } as never))).toContain("强烈");
  });
  it("arousal < 0.7 / 缺省 → 无 强烈", () => {
    expect(formatMemoryLine({ type: "episodic", content: "x", arousal: 0.69 } as never)).not.toContain("强烈");
    expect(formatMemoryLine({ type: "episodic", content: "x" } as never)).not.toContain("强烈");
  });
  it("recallCount ≥ 3 → ·验证×N（N=实际次数）", () => {
    expect(soulItems(formatMemoryLine({ type: "episodic", content: "x", recallCount: 3 } as never))).toContain("验证×3");
    expect(soulItems(formatMemoryLine({ type: "episodic", content: "x", recallCount: 12 } as never))).toContain("验证×12");
  });
  it("recallCount < 3 / 缺省 → 无 验证", () => {
    expect(formatMemoryLine({ type: "episodic", content: "x", recallCount: 2 } as never)).not.toContain("验证×");
    expect(formatMemoryLine({ type: "episodic", content: "x" } as never)).not.toContain("验证×");
  });
  it("identityRefs 非空 → ·核心事实；空数组/缺省 → 无", () => {
    expect(
      soulItems(formatMemoryLine({ type: "episodic", content: "x", identityRefs: ["我要求结论必须建立在代码事实上"] } as never)),
    ).toContain("核心事实");
    expect(formatMemoryLine({ type: "episodic", content: "x", identityRefs: [] } as never)).not.toContain("核心事实");
    expect(formatMemoryLine({ type: "episodic", content: "x" } as never)).not.toContain("核心事实");
  });
  it("evolution 存在 → ·已演化；缺省 → 无", () => {
    expect(soulItems(formatMemoryLine({ type: "episodic", content: "x", evolution: { refined: true } } as never))).toContain("已演化");
    expect(formatMemoryLine({ type: "episodic", content: "x" } as never)).not.toContain("已演化");
  });
  it("valid_start 存在 → ·自 date 起（日期精度）；缺省 → 无", () => {
    const line = formatMemoryLine({ type: "episodic", content: "x", valid_start: "2026-09-15T02:12:36.483Z" } as never);
    expect(line).toContain("自 2026-09-15 起");
    expect(line).not.toContain("02:12");
    expect(formatMemoryLine({ type: "episodic", content: "x" } as never)).not.toContain("自 ");
  });
  it("全字段缺省 → 行与现状逐字节一致（守卫）", () => {
    const line = formatMemoryLine({ type: "episodic", content: "用户计划五月去日本旅行", timestamp: "2025-05-01" } as never);
    expect(line).toBe("- [episodic] 用户计划五月去日本旅行 ·(活动时间: 2025-05-01)");
  });
  it("新徽章与既有 soul 徽章共存，MEMORY_LINE_RE 行首结构不破坏", () => {
    const line = formatMemoryLine({
      type: "episodic",
      content: "x",
      occurred_at: "2026-09-23T01:00:00Z",
      sensitivity: "finance",
      recurrence: { cadence: "weekly", anchor: "WED", note: "每周三" },
      arousal: 0.8,
      recallCount: 5,
      identityRefs: ["a"],
      evolution: {},
      valid_start: "2026-09-15T00:00:00Z",
    } as never);
    expect(line).toContain("敏感:财务");
    expect(line).toContain("周期:每周三");
    const items = soulItems(line);
    expect(items).toContain("强烈");
    expect(items).toContain("验证×5");
    expect(items).toContain("核心事实");
    expect(items).toContain("已演化");
    expect(items).toContain("自 2026-09-15 起");
    const m = line.match(MEMORY_LINE_RE);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("episodic");
  });
});

function mkVector(extra: Record<string, unknown>, metaJson: string) {
  return { record_id: "m_v", id: "m_v", type: "episodic", content: "c", score: 1, metadata_json: metaJson, ...extra } as never;
}
function mkFts(extra: Record<string, unknown>, metaJson: string) {
  return { record_id: "m_f", id: "m_f", type: "episodic", content: "c", metadata_json: metaJson, ...extra } as never;
}
function mkRecord(meta: Record<string, unknown>, extra: Record<string, unknown>) {
  return { type: "episodic", content: "c", timestamps: [], metadata: meta, ...extra } as never;
}

describe("三构造点属性透传（丢值点防线：向量/FTS/record——D-3 ④⑥ 同族）", () => {
  it("vectorResultToFormatable：metadata recall_count/identityRefs/evolution + 顶层 arousal/valid_start", () => {
    const m = vectorResultToFormatable(
      mkVector({ arousal: 0.9, valid_start: "2026-09-15T02:12:36.483Z" }, JSON.stringify({ recall_count: 5, identityRefs: ["a"], evolution: { v: 1 } })),
    );
    expect(m.recallCount).toBe(5);
    expect(m.identityRefs).toEqual(["a"]);
    expect(m.evolution).toEqual({ v: 1 });
    expect(m.arousal).toBe(0.9);
    expect(m.valid_start).toBe("2026-09-15T02:12:36.483Z");
  });
  it("ftsResultToFormatable：同上（双通道成对，丢一个=徽章单通道）", () => {
    const m = ftsResultToFormatable(
      mkFts({ arousal: 0.85, valid_start: "2026-09-20T00:00:00Z" }, JSON.stringify({ recall_count: 7, identityRefs: ["b"], evolution: { v: 2 } })),
    );
    expect(m.recallCount).toBe(7);
    expect(m.identityRefs).toEqual(["b"]);
    expect(m.evolution).toEqual({ v: 2 });
    expect(m.arousal).toBe(0.85);
    expect(m.valid_start).toBe("2026-09-20T00:00:00Z");
  });
  it("recordToFormatable：metadata 对象 + record 顶层 arousal/valid_start（kwSoul 路基座）", () => {
    const m = recordToFormatable(mkRecord({ recall_count: 3, identityRefs: ["b"] }, { arousal: 0.75, valid_start: "2026-09-01T00:00:00Z" }));
    expect(m.recallCount).toBe(3);
    expect(m.identityRefs).toEqual(["b"]);
    expect(m.evolution).toBeUndefined();
    expect(m.arousal).toBe(0.75);
    expect(m.valid_start).toBe("2026-09-01T00:00:00Z");
  });
  it("垃圾/缺失 metadata → undefined（不透传垃圾，守卫）", () => {
    const m = vectorResultToFormatable(mkVector({}, "not-json"));
    expect(m.recallCount).toBeUndefined();
    expect(m.identityRefs).toBeUndefined();
    expect(m.evolution).toBeUndefined();
    const f = ftsResultToFormatable(mkFts({}, "{}"));
    expect(f.recallCount).toBeUndefined();
  });
  it("recall_count 非法（字符串/0/负数）→ undefined（宁缺毋滥）", () => {
    expect(vectorResultToFormatable(mkVector({}, JSON.stringify({ recall_count: "3" }))).recallCount).toBeUndefined();
    expect(vectorResultToFormatable(mkVector({}, JSON.stringify({ recall_count: 0 }))).recallCount).toBeUndefined();
    expect(vectorResultToFormatable(mkVector({}, JSON.stringify({ recall_count: -1 }))).recallCount).toBeUndefined();
  });
  it("identityRefs 含非字符串元素 → 过滤后保留字符串项（或全非字符串则不透传）", () => {
    const m = vectorResultToFormatable(mkVector({}, JSON.stringify({ identityRefs: ["a", 3, null] })));
    expect(m.identityRefs).toEqual(["a"]);
    expect(vectorResultToFormatable(mkVector({}, JSON.stringify({ identityRefs: [1, 2] }))).identityRefs).toBeUndefined();
  });
});
