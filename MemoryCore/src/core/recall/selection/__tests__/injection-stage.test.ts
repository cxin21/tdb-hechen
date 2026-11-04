import { describe, expect, it } from "vitest";

import {
  applyInjectionSelection,
  classifyInjectionIntent,
  hash8,
  hashLines,
  injectionBudgetOf,
  layerOfMemoryLine,
  PRODUCTION_INJECTION_BUDGET,
  type InjectionBudgetByIntent,
  type InjectionRulerConfig,
} from "../injection-stage.js";

function line(tag: string, body: string): string {
  return `- [${tag}] ${body}`;
}

function unitVec(seed: number): Float32Array {
  // 二维单位向量：用余弦可控地构造相似度（seed=0 → 1, seed=π/3 → 0.5, seed=π/2 → 0）
  return new Float32Array([Math.cos(seed), Math.sin(seed)]);
}

function fakeEmbed(sims: number[]): (texts: string[]) => Promise<Float32Array[]> {
  const q = new Float32Array([1, 0]);
  return async (texts: string[]) => {
    // texts[0] = query，其余按 sims 顺序给出与 query 的余弦
    return texts.map((_, i) => (i === 0 ? q : unitVec(Math.acos(Math.max(-1, Math.min(1, sims[i - 1]))))));
  };
}

const OFF: InjectionRulerConfig = { mode: "off", keepRatio: 0.67, minPerLayer: 1, floor: null };
const NO_BUDGET: InjectionBudgetByIntent = { empty: null, continuation: null, self: null, info: null };

describe("classifyInjectionIntent", () => {
  it("空串与纯空白 → empty", () => {
    expect(classifyInjectionIntent("")).toBe("empty");
    expect(classifyInjectionIntent("   \n\t")).toBe("empty");
  });

  it("短续接语 → continuation", () => {
    for (const q of ["继续", "接着说吧", "然后呢", "还有呢", "展开说说", "go on", "continue"]) {
      expect(classifyInjectionIntent(q), q).toBe("continuation");
    }
  });

  it("带实体的短问题不算续接 → info", () => {
    for (const q of ["项目进展如何", "部署脚本在哪", "继续昨天那个采购单据改造"] as const) {
      expect(classifyInjectionIntent(q), q).toBe("info");
    }
  });

  it("自指召回查询 → self", () => {
    expect(classifyInjectionIntent("你还记得我之前说过的部署偏好吗")).toBe("self");
    expect(classifyInjectionIntent("你上次说的那个部署脚本叫什么")).toBe("self");
    // 「帮我回忆…」不是第二人称回忆句（isAssistantRecallQuery 需第二人称），归 info
    expect(classifyInjectionIntent("帮我回忆一下上次那个脚本")).toBe("info");
  });

  it("普通信息型查询 → info", () => {
    expect(classifyInjectionIntent("采购订单保存时报错怎么排查")).toBe("info");
  });
});

describe("injectionBudgetOf", () => {
  it("未配置（null）即今天行为：不裁", () => {
    expect(injectionBudgetOf("info", NO_BUDGET)).toBeNull();
    expect(injectionBudgetOf("continuation", NO_BUDGET)).toBeNull();
  });

  it("配置值按意图取用，0 是有效取值", () => {
    const b: InjectionBudgetByIntent = PRODUCTION_INJECTION_BUDGET;
    expect(injectionBudgetOf("empty", b)).toBe(0);
    expect(injectionBudgetOf("continuation", b)).toBe(1);
    expect(injectionBudgetOf("self", b)).toBe(1);
    expect(injectionBudgetOf("info", b)).toBeNull();
  });
});

describe("layerOfMemoryLine / hash", () => {
  it("从行首 - [类型|场景] 提取层，剥离活动时间等尾巴", () => {
    expect(layerOfMemoryLine(line("work_fact|项目A", "内容 ·(活动时间: 2026-10-01)"))).toBe("work_fact");
    expect(layerOfMemoryLine(line("conclusion", "内容"))).toBe("conclusion");
    expect(layerOfMemoryLine("裸文本没有前缀")).toBe("unknown");
  });

  it("hash8 是 8 位十六进制且同文同值", () => {
    const a = hash8("同一行");
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(hash8("同一行")).toBe(a);
    expect(hash8("另一行")).not.toBe(a);
  });

  it("hashLines 对顺序敏感、对同样输入稳定", () => {
    const h = hashLines(["a", "b"]);
    expect(hashLines(["a", "b"])).toBe(h);
    expect(hashLines(["b", "a"])).not.toBe(h);
  });
});

describe("applyInjectionSelection", () => {
  const lines = [
    line("work_fact|项目A", "第一行工作事实"),
    line("work_fact|项目A", "第二行工作事实"),
    line("conclusion", "第一条结论"),
    line("conclusion", "第二条结论"),
  ];

  it("mode=off：逐字不变、不嵌、droppedBy 全 0、候选全 kept", async () => {
    let called = 0;
    const out = await applyInjectionSelection({
      lines,
      query: "采购订单报错",
      ruler: OFF,
      foldIdentical: false,
      budgetByIntent: NO_BUDGET,
      embedBatch: async (t) => {
        called++;
        return t.map(() => new Float32Array([1, 0]));
      },
    });
    expect(called).toBe(0);
    expect(out.lines).toEqual(lines);
    expect(out.selection.kept).toBe(4);
    expect(out.selection.droppedBy).toEqual({ rank: 0, floor: 0, margin: 0, dup: 0, budget: 0, chars: 0, fold: 0 });
    expect(out.ruler.mode).toBe("off");
    expect(out.ruler.floorSource).toBe("uncalibrated");
    expect(out.ruler.floor).toBeNull();
    expect(out.candidates.total).toBe(4);
    expect(out.candidates.byLayer).toEqual({ work_fact: 2, conclusion: 2 });
    expect(out.candidates.lines.every((c) => c.kept && c.droppedBy === undefined)).toBe(true);
    expect(out.candidates.lines.every((c) => c.scoreQ === undefined)).toBe(true);
  });

  it("意图预算：continuation 留 1 行、empty 留 0 行，其余按 budget 归因", async () => {
    const b: InjectionBudgetByIntent = { empty: 0, continuation: 1, self: 1, info: null };
    const one = await applyInjectionSelection({
      lines,
      query: "继续",
      ruler: OFF,
      foldIdentical: false,
      budgetByIntent: b,
    });
    expect(one.lines).toEqual([lines[0]]);
    expect(one.selection.kept).toBe(1);
    expect(one.selection.droppedBy.budget).toBe(3);

    const zero = await applyInjectionSelection({
      lines,
      query: "   ",
      ruler: OFF,
      foldIdentical: false,
      budgetByIntent: b,
    });
    expect(zero.lines).toEqual([]);
    expect(zero.selection.kept).toBe(0);
    expect(zero.selection.droppedBy.budget).toBe(4);

    const info = await applyInjectionSelection({
      lines,
      query: "采购订单保存报错怎么排查",
      ruler: OFF,
      foldIdentical: false,
      budgetByIntent: b,
    });
    expect(info.lines).toEqual(lines);
  });

  it("同回合逐字节相同的注入折叠为 0 行", async () => {
    const first = await applyInjectionSelection({
      lines,
      query: "采购订单报错",
      ruler: OFF,
      foldIdentical: true,
      budgetByIntent: NO_BUDGET,
    });
    const second = await applyInjectionSelection({
      lines,
      query: "采购订单报错",
      ruler: OFF,
      foldIdentical: true,
      budgetByIntent: NO_BUDGET,
      previousHash: first.foldHash,
    });
    expect(second.lines).toEqual([]);
    expect(second.fold.identicalLines).toBe(4);
    expect(second.selection.droppedBy.fold).toBe(4);
    expect(second.selection.kept).toBe(0);

    const third = await applyInjectionSelection({
      lines: [...lines, line("conclusion", "新增结论")],
      query: "采购订单报错",
      ruler: OFF,
      foldIdentical: true,
      budgetByIntent: NO_BUDGET,
      previousHash: first.foldHash,
    });
    expect(third.lines).toHaveLength(5);
    expect(third.fold.identicalLines).toBe(0);
  });

  it("foldIdentical=false 时不折叠（缺省=今天行为）", async () => {
    const first = await applyInjectionSelection({
      lines,
      query: "q",
      ruler: OFF,
      foldIdentical: false,
      budgetByIntent: NO_BUDGET,
    });
    const second = await applyInjectionSelection({
      lines,
      query: "q",
      ruler: OFF,
      foldIdentical: false,
      budgetByIntent: NO_BUDGET,
      previousHash: first.foldHash,
    });
    expect(second.lines).toEqual(lines);
    expect(second.fold.identicalLines).toBe(0);
  });

  it("floor：低于标定地板的行被 floor 归因丢掉", async () => {
    const out = await applyInjectionSelection({
      lines,
      query: "采购订单报错",
      ruler: { mode: "enforce", keepRatio: 1, minPerLayer: 1, floor: null },
      foldIdentical: false,
      budgetByIntent: NO_BUDGET,
      calibration: new Map([["fake-model@2", 0.5]]),
      model: "fake-model",
      dimensions: 2,
      embedBatch: fakeEmbed([0.9, 0.6, 0.4, 0.1]),
    });
    expect(out.ruler.floorSource).toBe("calibration");
    expect(out.ruler.floor).toBe(0.5);
    expect(out.selection.droppedBy.floor).toBe(2);
    expect(out.lines).toEqual([lines[0], lines[1]]);
    expect(out.candidates.lines.map((c) => c.droppedBy)).toEqual([undefined, undefined, "floor", "floor"]);
  });

  it("config floor 优先于标定文件", async () => {
    const out = await applyInjectionSelection({
      lines,
      query: "采购订单报错",
      ruler: { mode: "enforce", keepRatio: 1, minPerLayer: 1, floor: 0.7 },
      foldIdentical: false,
      budgetByIntent: NO_BUDGET,
      calibration: new Map([["fake-model@2", 0.1]]),
      model: "fake-model",
      dimensions: 2,
      embedBatch: fakeEmbed([0.9, 0.6, 0.4, 0.1]),
    });
    expect(out.ruler.floorSource).toBe("config");
    expect(out.ruler.floor).toBe(0.7);
    expect(out.lines).toEqual([lines[0]]);
    expect(out.selection.droppedBy.floor).toBe(3);
  });

  it("名次尺：enforce 按层各留 ceil(n×ratio)，零竞争", async () => {
    const out = await applyInjectionSelection({
      lines,
      query: "采购订单报错",
      ruler: { mode: "enforce", keepRatio: 0.5, minPerLayer: 1, floor: null },
      foldIdentical: false,
      budgetByIntent: NO_BUDGET,
      embedBatch: fakeEmbed([0.9, 0.8, 0.4, 0.1]),
    });
    expect(out.lines).toEqual([lines[0], lines[2]]);
    expect(out.selection.droppedBy.rank).toBe(2);
    expect(out.selection.kept).toBe(2);
  });

  it("shadow：判定照做但不改注入，kept 为判定值、injected 为实注入", async () => {
    const out = await applyInjectionSelection({
      lines,
      query: "采购订单报错",
      ruler: { mode: "shadow", keepRatio: 0.5, minPerLayer: 1, floor: null },
      foldIdentical: false,
      budgetByIntent: NO_BUDGET,
      embedBatch: fakeEmbed([0.9, 0.8, 0.4, 0.1]),
    });
    expect(out.lines).toEqual(lines);
    expect(out.selection.kept).toBe(2);
    expect(out.selection.injected).toBe(4);
    expect(out.ruler.mode).toBe("shadow");
    expect(out.candidates.lines.filter((c) => c.kept)).toHaveLength(2);
  });

  it("嵌入抛错 → bypass：注入与 mode:off 逐位一致并记 ruler-unavailable", async () => {
    const base = await applyInjectionSelection({
      lines,
      query: "采购订单报错",
      ruler: OFF,
      foldIdentical: false,
      budgetByIntent: NO_BUDGET,
    });
    const out = await applyInjectionSelection({
      lines,
      query: "采购订单报错",
      ruler: { mode: "enforce", keepRatio: 0.67, minPerLayer: 1, floor: 0.3 },
      foldIdentical: false,
      budgetByIntent: NO_BUDGET,
      embedBatch: async () => {
        throw new Error("embedding down");
      },
    });
    expect(out.lines).toEqual(base.lines);
    expect(out.ruler.bypass).toBe("ruler-unavailable");
    expect(out.selection.kept).toBe(4);
    expect(out.selection.droppedBy).toEqual({ rank: 0, floor: 0, margin: 0, dup: 0, budget: 0, chars: 0, fold: 0 });
    expect(out.candidates.lines.every((c) => c.scoreQ === undefined)).toBe(true);
  });

  it("选线增量超预算 → 立即 bypass（ruler-budget），注入与 mode:off 逐位一致", async () => {
    const base = await applyInjectionSelection({
      lines,
      query: "采购订单报错",
      ruler: OFF,
      foldIdentical: false,
      budgetByIntent: NO_BUDGET,
    });
    const started = Date.now();
    const out = await applyInjectionSelection({
      lines,
      query: "采购订单报错",
      ruler: { mode: "enforce", keepRatio: 0.67, minPerLayer: 1, floor: 0.3 },
      foldIdentical: false,
      budgetByIntent: NO_BUDGET,
      budgetMs: 30,
      embedBatch: async (texts) => {
        // 比预算还慢的嵌入：必须在预算到点就放弃，不等它回来
        await new Promise((resolve) => setTimeout(resolve, 300));
        return fakeEmbed([0.9, 0.8, 0.2, 0.1])(texts);
      },
    });
    expect(out.ruler.bypass).toBe("ruler-budget");
    expect(out.lines).toEqual(base.lines);
    expect(out.selection.kept).toBe(4);
    expect(out.selection.droppedBy).toEqual({ rank: 0, floor: 0, margin: 0, dup: 0, budget: 0, chars: 0, fold: 0 });
    expect(out.candidates.lines.every((c) => c.scoreQ === undefined)).toBe(true);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("嵌入超时 → bypass 且整体耗时受控", async () => {
    const started = Date.now();
    const out = await applyInjectionSelection({
      lines,
      query: "采购订单报错",
      ruler: { mode: "enforce", keepRatio: 0.67, minPerLayer: 1, floor: null },
      foldIdentical: false,
      budgetByIntent: NO_BUDGET,
      budgetMs: 40,
      embedBatch: () => new Promise<Float32Array[]>(() => {}),
    });
    expect(out.ruler.bypass).toBe("ruler-budget");
    expect(out.lines).toEqual(lines);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("空向量/零向量 → bypass（绝不当作 0 相似度全砍）", async () => {
    const out = await applyInjectionSelection({
      lines,
      query: "采购订单报错",
      ruler: { mode: "enforce", keepRatio: 0.67, minPerLayer: 1, floor: 0.3 },
      foldIdentical: false,
      budgetByIntent: NO_BUDGET,
      embedBatch: async (texts) => texts.map(() => new Float32Array([0, 0])),
    });
    expect(out.ruler.bypass).toBe("ruler-unavailable");
    expect(out.lines).toEqual(lines);
  });

  it("候选池超过 40 条：truncated 标记但汇总完整，单轮新增字段 <4KB", async () => {
    const many = Array.from({ length: 45 }, (_, i) =>
      line(i % 2 === 0 ? "work_fact|项目A" : "conclusion", `第 ${i} 条记忆内容 ${"填充".repeat(30)}`),
    );
    const out = await applyInjectionSelection({
      lines: many,
      query: "采购订单报错",
      ruler: { mode: "enforce", keepRatio: 0.67, minPerLayer: 1, floor: null },
      foldIdentical: false,
      budgetByIntent: NO_BUDGET,
      embedBatch: async (texts) => texts.map((_, i) => unitVec(i / 10)),
    });
    expect(out.candidates.total).toBe(45);
    expect(out.candidates.byLayer).toEqual({ work_fact: 23, conclusion: 22 });
    expect(out.candidates.lines).toHaveLength(40);
    expect(out.candidates.truncated).toBe(true);
    expect(out.selection.kept + out.selection.droppedBy.rank).toBe(45);
    const bytes = Buffer.byteLength(
      JSON.stringify({
        selection: out.selection,
        ruler: out.ruler,
        fold: out.fold,
        candidates: out.candidates,
      }),
      "utf8",
    );
    expect(bytes).toBeLessThan(4096);
  });

  it("空注入行不产生候选也不报错", async () => {
    const out = await applyInjectionSelection({
      lines: [],
      query: "",
      ruler: { mode: "enforce", keepRatio: 0.67, minPerLayer: 1, floor: null },
      foldIdentical: true,
      budgetByIntent: { ...PRODUCTION_INJECTION_BUDGET },
      embedBatch: fakeEmbed([]),
    });
    expect(out.lines).toEqual([]);
    expect(out.candidates.total).toBe(0);
    expect(out.selection.kept).toBe(0);
  });
});

describe("#179 v2 · 长度折扣（lengthLambda）", () => {
  const longBody = "批次总结：" + "甲".repeat(2000);
  const shortBody = "部署脚本在 tools/deploy.sh，重启前先跑 typecheck。";

  it("λ=0（缺省）→ 纯余弦，长行赢（逐位现状）", async () => {
    const out = await applyInjectionSelection({
      lines: [line("work_fact", shortBody), line("work_fact", longBody)],
      query: "部署脚本在哪",
      ruler: { mode: "enforce", keepRatio: 0.5, minPerLayer: 1, floor: null },
      foldIdentical: false,
      budgetByIntent: NO_BUDGET,
      embedBatch: fakeEmbed([0.5, 0.55]),
    });
    expect(out.lines).toEqual([line("work_fact", longBody)]);
    expect(out.selection.droppedBy.rank).toBe(1);
  });

  it("λ=0.06 → 长行被长度折扣压到短行之后（同一对行，只改名次）", async () => {
    const out = await applyInjectionSelection({
      lines: [line("work_fact", shortBody), line("work_fact", longBody)],
      query: "部署脚本在哪",
      ruler: { mode: "enforce", keepRatio: 0.5, minPerLayer: 1, floor: null, lengthLambda: 0.06 },
      foldIdentical: false,
      budgetByIntent: NO_BUDGET,
      embedBatch: fakeEmbed([0.5, 0.55]),
    });
    expect(out.lines).toEqual([line("work_fact", shortBody)]);
    expect(out.candidates.lines[1]?.droppedBy).toBe("rank");
  });
});

describe("#179 v2 · 近重复抑制（dedupeSim）", () => {
  const a = line("work_fact", "采购订单保存时提示供应商必填，因为模板校验在保存前执行。");
  const b = line("work_fact", "采购订单保存提示供应商必填，原因是模板校验先于保存执行。");
  const c = line("work_fact", "部署脚本在 tools/deploy.sh，需要先跑 typecheck。");

  it("缺省不折叠（逐位现状）", async () => {
    const out = await applyInjectionSelection({
      lines: [a, b, c],
      query: "采购订单保存报错",
      ruler: { mode: "enforce", keepRatio: 1, minPerLayer: 1, floor: null },
      foldIdentical: false,
      budgetByIntent: NO_BUDGET,
      embedBatch: fakeEmbed([0.9, 0.86, 0.3]),
    });
    expect(out.selection.injected).toBe(3);
  });

  it("dedupeSim=0.92 → 近重复行只留名次靠前的（droppedBy.dup=1）", async () => {
    const out = await applyInjectionSelection({
      lines: [a, b, c],
      query: "采购订单保存报错",
      ruler: { mode: "enforce", keepRatio: 1, minPerLayer: 1, floor: null, dedupeSim: 0.92 },
      foldIdentical: false,
      budgetByIntent: NO_BUDGET,
      embedBatch: fakeEmbed([0.9, 0.86, 0.3]),
    });
    expect(out.lines).toEqual([a, c]);
    expect(out.selection.droppedBy.dup).toBe(1);
    expect(out.selection.injected).toBe(2);
  });
});

describe("#179 v2 · 行长上限（maxLineChars）", () => {
  const body = "第一句关于部署。第二句关于重启。第三句关于回滚。第四句关于验证。第五句关于收口。";

  it("缺省 null → 不截断（逐位现状）", async () => {
    const out = await applyInjectionSelection({
      lines: [line("work_fact", body)],
      query: "部署流程",
      ruler: { mode: "off", keepRatio: 0.67, minPerLayer: 1, floor: null },
      foldIdentical: false,
      budgetByIntent: NO_BUDGET,
    });
    expect(out.lines[0]).toBe(line("work_fact", body));
  });

  it("maxLineChars=20 → 在句界截断并留省略号，绝不切半个字", async () => {
    const out = await applyInjectionSelection({
      lines: [line("work_fact", body)],
      query: "部署流程",
      ruler: { mode: "off", keepRatio: 0.67, minPerLayer: 1, floor: null },
      foldIdentical: false,
      budgetByIntent: NO_BUDGET,
      maxLineChars: 20,
    });
    const got = out.lines[0];
    expect(got.length).toBeLessThanOrEqual(21);
    expect(got.endsWith("…")).toBe(true);
    expect(got).toContain("- [work_fact]");
    expect(out.selection.capped).toBe(1);
  });
});

describe("#179 v3 · 字符预算（maxChars）", () => {
  const long = (n: number) => "字".repeat(n);
  const lines = [
    line("work_fact", long(200)),
    line("work_fact", long(200)),
    line("conclusion", long(200)),
    line("conclusion", long(200)),
  ];

  it("缺省 null → 不裁（逐位现状）", async () => {
    const out = await applyInjectionSelection({
      lines,
      query: "采购订单报错",
      ruler: { mode: "enforce", keepRatio: 1, minPerLayer: 1, floor: 0.3 },
      foldIdentical: false,
      budgetByIntent: NO_BUDGET,
      embedBatch: fakeEmbed([0.9, 0.8, 0.7, 0.6]),
    });
    expect(out.lines.length).toBe(4);
    expect(out.selection.droppedBy.chars).toBe(0);
    expect(out.ruler.maxChars).toBeNull();
  });

  it("maxChars=450 → 按名次装填（0.9/0.8 两行），其余记 chars，注入行与判定集一致", async () => {
    const out = await applyInjectionSelection({
      lines,
      query: "采购订单报错",
      ruler: { mode: "enforce", keepRatio: 1, minPerLayer: 1, floor: 0.3 },
      foldIdentical: false,
      budgetByIntent: NO_BUDGET,
      embedBatch: fakeEmbed([0.9, 0.8, 0.7, 0.6]),
      maxChars: 450,
    });
    expect(out.lines.length).toBe(2);
    expect(out.selection.droppedBy.chars).toBe(2);
    expect(out.ruler.maxChars).toBe(450);
    expect(out.candidates.lines.filter((c) => c.droppedBy === "chars")).toHaveLength(2);
  });

  it("poolChars/injectedChars 自证口径：池=输入和、注入=输出和，且注入≤maxChars", async () => {
    const out = await applyInjectionSelection({
      lines,
      query: "采购订单报错",
      ruler: { mode: "enforce", keepRatio: 1, minPerLayer: 1, floor: 0.3 },
      foldIdentical: false,
      budgetByIntent: NO_BUDGET,
      embedBatch: fakeEmbed([0.9, 0.8, 0.7, 0.6]),
      maxChars: 450,
    });
    expect(out.selection.poolChars).toBe(lines.reduce((n, s) => n + s.length, 0));
    expect(out.selection.injectedChars).toBe(out.lines.reduce((n, s) => n + s.length, 0));
    expect(out.selection.injectedChars).toBeLessThanOrEqual(450);
    // 关键：注入字符 ≠ 池字符（实测曾把池 1400 当注入 562）
    expect(out.selection.poolChars).toBeGreaterThan(out.selection.injectedChars);
  });

  it("同回合折叠为 0 行 → injectedChars 恒 0，池不变", async () => {
    const cfg = {
      lines,
      query: "采购订单报错",
      ruler: { mode: "enforce" as const, keepRatio: 1, minPerLayer: 1, floor: 0.3 },
      foldIdentical: true,
      budgetByIntent: NO_BUDGET,
      embedBatch: fakeEmbed([0.9, 0.8, 0.7, 0.6]),
      maxChars: 900,
    };
    const first = await applyInjectionSelection(cfg);
    const second = await applyInjectionSelection({ ...cfg, previousHash: first.foldHash });
    expect(second.lines).toEqual([]);
    expect(second.selection.injectedChars).toBe(0);
    expect(second.selection.poolChars).toBe(first.selection.poolChars);
  });

  it("mode=off 时不生效（off 逐位现状，字符预算属于选线面）", async () => {
    const out = await applyInjectionSelection({
      lines,
      query: "采购订单报错",
      ruler: { mode: "off", keepRatio: 0.67, minPerLayer: 1, floor: null },
      foldIdentical: false,
      budgetByIntent: NO_BUDGET,
      maxChars: 450,
    });
    expect(out.lines).toEqual(lines);
    expect(out.selection.droppedBy.chars).toBe(0);
  });
});

describe("#179 v3 · bypass 时的字符预算兜底（fallback=char-budget）", () => {
  const long = (n: number) => "字".repeat(n);
  const lines = [
    line("work_fact", long(250)),
    line("work_fact", long(250)),
    line("conclusion", long(250)),
    line("conclusion", long(250)),
  ];

  it("超时 + 配了 maxChars → 不退回全量：按原序装填到预算，其余记 chars", async () => {
    const out = await applyInjectionSelection({
      lines,
      query: "采购订单报错",
      ruler: { mode: "enforce", keepRatio: 1, minPerLayer: 1, floor: 0.3 },
      foldIdentical: false,
      budgetByIntent: NO_BUDGET,
      budgetMs: 30,
      maxChars: 600,
      embedBatch: async (texts) => {
        await new Promise((r) => setTimeout(r, 300));
        return fakeEmbed([0.9, 0.8, 0.7, 0.6])(texts);
      },
    });
    expect(out.ruler.bypass).toBe("ruler-budget");
    expect(out.ruler.fallback).toBe("char-budget");
    expect(out.lines).toEqual(lines.slice(0, 2)); // 原序装填，不引入新排序
    expect(out.selection.droppedBy.chars).toBe(2);
    expect(out.selection.kept).toBe(2);
  });

  it("语义通道不可用（无 embedBatch）+ 配了 maxChars → 同样兜底", async () => {
    const out = await applyInjectionSelection({
      lines,
      query: "采购订单报错",
      ruler: { mode: "enforce", keepRatio: 1, minPerLayer: 1, floor: 0.3 },
      foldIdentical: false,
      budgetByIntent: NO_BUDGET,
      maxChars: 600,
    });
    expect(out.ruler.bypass).toBe("ruler-unavailable");
    expect(out.ruler.fallback).toBe("char-budget");
    expect(out.lines).toEqual(lines.slice(0, 2));
  });

  it("跨会话 + 配了 maxChars → 兜底也守会话份额（第二个会话的首条不被长轮挤掉）", async () => {
    const out = await applyInjectionSelection({
      lines,
      query: "采购订单报错",
      ruler: { mode: "enforce", keepRatio: 1, minPerLayer: 1, floor: 0.3 },
      foldIdentical: false,
      budgetByIntent: NO_BUDGET,
      maxChars: 600,
      // 前两行属于会话 A、后两行属于会话 B：份额 = floor(600×3/5) = 360
      // ⇒ 会话 A 只能进首条（第二条起受份额约束），省下的预算留给会话 B 的首条。
      sessions: ["sA", "sA", "sB", "sB"],
    });
    expect(out.ruler.bypass).toBe("ruler-unavailable");
    expect(out.ruler.fallback).toBe("char-budget");
    expect(out.lines).toEqual([lines[0], lines[2]]);
    expect(out.selection.droppedBy.chars).toBe(2);
  });

  it("bypass + 剩余预算 → 用证据窗回填被 chars 丢掉的长行（不留空预算）", async () => {
    const huge = line("work_fact", "字".repeat(2000));
    const out = await applyInjectionSelection({
      lines: [huge, ...lines],
      query: "采购订单报错",
      ruler: { mode: "enforce", keepRatio: 1, minPerLayer: 1, floor: 0.3 },
      foldIdentical: false,
      budgetByIntent: NO_BUDGET,
      maxChars: 900,
    });
    expect(out.ruler.bypass).toBe("ruler-unavailable");
    expect(out.ruler.fallback).toBe("char-budget");
    // 首条 2000 字整行装不进 900：先被 chars 丢掉，再由回填裁成证据窗注入
    expect(out.selection.windowed).toBeGreaterThanOrEqual(1);
    const total = out.lines.reduce((n, l) => n + l.length, 0);
    expect(total).toBeLessThanOrEqual(900);
    expect(out.lines.join("")).toContain("（节选）");
  });

  it("单会话候选池 → 份额不生效（与旧行为逐位相同）", async () => {
    const out = await applyInjectionSelection({
      lines,
      query: "采购订单报错",
      ruler: { mode: "enforce", keepRatio: 1, minPerLayer: 1, floor: 0.3 },
      foldIdentical: false,
      budgetByIntent: NO_BUDGET,
      maxChars: 600,
      sessions: ["sA", "sA", "sA", "sA"],
    });
    expect(out.lines).toEqual(lines.slice(0, 2));
  });

  it("预算小到一行都装不下 → 注入 0 行（仍算兜底生效，绝不退回全量）", async () => {
    const out = await applyInjectionSelection({
      lines,
      query: "采购订单报错",
      ruler: { mode: "enforce", keepRatio: 1, minPerLayer: 1, floor: 0.3 },
      foldIdentical: false,
      budgetByIntent: NO_BUDGET,
      // 每行 260+ 字符 > cap，且 cap 小到证据窗都放不下（cap−12 < 60）：贪心装填一行都放不下
      maxChars: 50,
    });
    expect(out.ruler.bypass).toBe("ruler-unavailable");
    expect(out.ruler.fallback).toBe("char-budget");
    expect(out.lines).toEqual([]);
    expect(out.selection.kept).toBe(0);
    expect(out.selection.droppedBy.chars).toBe(4);
  });

  it("未配 maxChars → bypass 时逐位退回全量（现状不变，无 fallback 字段）", async () => {
    const out = await applyInjectionSelection({
      lines,
      query: "采购订单报错",
      ruler: { mode: "enforce", keepRatio: 1, minPerLayer: 1, floor: 0.3 },
      foldIdentical: false,
      budgetByIntent: NO_BUDGET,
      budgetMs: 40,
      embedBatch: () => new Promise<Float32Array[]>(() => {}),
    });
    expect(out.lines).toEqual(lines);
    expect(out.ruler.fallback).toBeUndefined();
    expect(out.selection.droppedBy.chars).toBe(0);
  });
});

// 2026-11-03：零行保护（LME90 归因后的契约，TDD 追补用例）。
describe("零行保护：自指/信息型意图不许注入空块", () => {
  const ENFORCE: InjectionRulerConfig = { mode: "enforce", keepRatio: 0.67, minPerLayer: 1, floor: 0.3 };

  it("self 意图 + 唯一候选低于地板 → 仍保留 1 行（不给空块）", async () => {
    const lines = [line("work_fact", "你上次说的部署脚本叫 deploy.ps1")];
    const out = await applyInjectionSelection({
      lines,
      query: "你上次说的部署脚本叫什么",
      ruler: ENFORCE,
      foldIdentical: false,
      budgetByIntent: { ...PRODUCTION_INJECTION_BUDGET },
      embedBatch: fakeEmbed([0.1]), // 低于 0.3 地板
    });
    expect(out.selection.droppedBy.budget).toBe(0);
    expect(out.lines).toHaveLength(1);
    expect(out.selection.kept).toBe(1);
  });

  it("continuation 意图 + 低于地板 → 保持 0 行（本就不该注）", async () => {
    const lines = [line("work_fact", "继续上次那个话题的细节")];
    const out = await applyInjectionSelection({
      lines,
      query: "继续",
      ruler: ENFORCE,
      foldIdentical: false,
      budgetByIntent: { ...PRODUCTION_INJECTION_BUDGET },
      embedBatch: fakeEmbed([0.1]),
    });
    expect(out.lines).toHaveLength(0);
  });

  it("info 意图 + 全部行超 maxChars → 证据窗装进预算（不再整行丢弃留空块）", async () => {
    const lines = [line("work_fact", "长".repeat(700)), line("work_fact", "也很长".repeat(200))];
    const out = await applyInjectionSelection({
      lines,
      query: "我们上次讨论的向量维度是多少",
      ruler: ENFORCE,
      maxChars: 600,
      foldIdentical: false,
      budgetByIntent: NO_BUDGET,
      embedBatch: fakeEmbed([0.1, 0.2]),
    });
    // 2026-11-03：整行装不下 → 换成「头+命中窗+尾」的节选后装进 600；成本契约仍然成立。
    expect(out.selection.windowed).toBe(2);
    expect(out.lines.length).toBeGreaterThan(0);
    for (const l of out.lines) expect(l.length).toBeLessThanOrEqual(600);
  });

  it("最高分行超预算 → 用证据窗压进预算后再按分数取行（不再整行放弃）", async () => {
    const long = line("work_fact", "超长事实".repeat(200)); // 800 字 ≫ 预算
    const short = line("work_fact", "召回选线用的是余弦地板 0.3");
    const out = await applyInjectionSelection({
      lines: [long, short],
      query: "召回选线地板是多少",
      ruler: ENFORCE,
      maxChars: 600,
      foldIdentical: false,
      budgetByIntent: NO_BUDGET,
      embedBatch: fakeEmbed([0.29, 0.25]), // 两行都在 0.3 地板下；长行分更高但装不下
    });
    expect(out.lines.length).toBeGreaterThanOrEqual(1);
    // 窗化后长行也装得进 600：胜负回到分数本身，但没有任何一行超预算（成本契约不变）。
    for (const l of out.lines) expect(l.length).toBeLessThanOrEqual(600);
    expect(out.selection.windowed).toBe(1);
  });

  it("超长行只领自己的份额（不为它一条吃掉整块，其它证据仍有位置）", async () => {
    const lines = [
      line("work_fact", "超长事实".repeat(750)), // 3000 字 ≫ 预算
      line("work_fact", "厨房收纳：餐具架按用途分层"),
      line("work_fact", "客厅除尘：吸尘器和空气净化器"),
      line("work_fact", "猫 Luna 掉毛多，需要常清洗猫窝"),
    ];
    const out = await applyInjectionSelection({
      lines,
      query: "厨房怎么收纳更整洁",
      ruler: ENFORCE,
      maxChars: 800,
      foldIdentical: false,
      budgetByIntent: NO_BUDGET,
      embedBatch: fakeEmbed([0.9, 0.8, 0.7, 0.6]),
    });
    // 2026-11-04（win 臂回归）：窗预算是 maxChars/候选数 —— 800/4=200，长行只拿 200，
    // 其余短行照常进块；旧行为是长行窗到 800 独占整块（afdc33df/35a27287 块塌成 1 行）。
    expect(out.selection.windowed).toBe(1);
    expect(out.lines.length).toBeGreaterThanOrEqual(3);
    for (const l of out.lines) expect(l.length).toBeLessThanOrEqual(800);
  });

  it("保回的行在观测面打 rescued 标记（kept=true 但仍记 droppedBy 原账已冲销）", async () => {
    const lines = [line("work_fact", "你上次说的部署脚本叫 deploy.ps1")];
    const out = await applyInjectionSelection({
      lines,
      query: "你上次说的部署脚本叫什么",
      ruler: ENFORCE,
      maxChars: 600,
      foldIdentical: false,
      budgetByIntent: { ...PRODUCTION_INJECTION_BUDGET },
      embedBatch: fakeEmbed([0.1]),
    });
    expect(out.selection.rescued).toBe(1);
    expect(out.selection.droppedBy.floor).toBe(0);
    expect(out.candidates.lines[0]).toMatchObject({ kept: true, rescued: true });
  });

  it("池为空 → 0 行（保护不凭空造证据）", async () => {
    const out = await applyInjectionSelection({
      lines: [],
      query: "你还记得我之前说过的部署偏好吗",
      ruler: ENFORCE,
      foldIdentical: false,
      budgetByIntent: { ...PRODUCTION_INJECTION_BUDGET },
      embedBatch: fakeEmbed([]),
    });
    expect(out.lines).toEqual([]);
  });
});
