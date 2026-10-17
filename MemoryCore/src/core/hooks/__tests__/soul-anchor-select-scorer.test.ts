/**
 * #42（ADR0003-P3 实施票 D / D9）：soul-assembler 锚选择打分器接线测试。
 * 合同：shadow（scorer 缺省关）只报告不裁剪=渲染逐位现状，报告随向量可用性升级为
 * 逐锚分形态 `锚N(0.xxx)`；转正（scorer.enabled=true）=threshold 硬门+top-K 重排渲染行，
 * 缺省关=逐位现状 golden；embedder/query 缺席→回退现状形态（宁缺毋滥不造分）。
 * 锚点：价值锚行 budgeted=applyAnchorBudget(decorated,…)（soul-assembler.ts:357）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildSoulPrefix, resetSoulScorerMisconfigWarnForTest } from "../soul-assembler.js";
import { resetAnchorVectorCacheForTest, type AnchorEmbedder } from "../soul-anchor-scorer.js";

const TENANT = { teamId: "tsh", userId: "u1", agentId: "a1" };

function makeStore(rows: Array<Record<string, unknown>>) {
  return {
    readCore: async () => [] as Array<Record<string, string>>,
    listValues: async () => rows,
  } as never;
}

const themed = (i: number) => ({
  value_id: `v${String(i).padStart(2, "0")}`,
  label: `锚${i}`,
  weight: 0.5,
  valence: 1,
  state: "active",
  node_type: "theme",
  attrs_json: `{"description":"第${i}号锚的稳定描述句。"}`,
});

function spyLogger() {
  const warns: string[] = [];
  return { warns, logger: { warn: (m: string) => void warns.push(m) } as never };
}

/** 确定性 stub：偶数号锚=查询同向（score=1），奇数号=正交（score=0）。
 *  合同工件修正：RED 阶段测试体未运行，原 stub 偶数锚向量 [1,1] 对 query [1,0]
 *  的 cosine=√½≠1——改为同向 [1,0]/正交 [0,1] 与注释一致。 */
function stubEmbedder() {
  return vi.fn(async (t: string) => {
    const m = t.match(/第(\d+)号锚/);
    const i = m ? Number(m[1]) : -1;
    return new Float32Array([i % 2 === 0 ? 1 : 0, i % 2 === 0 ? 0 : 1]);
  });
}

describe("#42 锚选择打分器接线（soul-assembler）", () => {
  beforeEach(() => resetAnchorVectorCacheForTest());

  it("shadow+embedder：渲染逐位不变（零裁剪 golden），报告升级为逐锚分形态", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => themed(i));
    const base = await buildSoulPrefix(makeStore(rows), { ...TENANT, userId: "u-base" }, undefined, {});
    const embed = stubEmbedder();
    const { warns, logger } = spyLogger();
    const out = await buildSoulPrefix(
      makeStore(rows),
      { ...TENANT, userId: "u-sh" },
      logger,
      {
        anchorSelect: {
          maxRows: 5,
          scorer: { enabled: false, threshold: 0, queryEmbedding: new Float32Array([1, 0]), embedder: embed },
        },
      },
    );
    expect(out).toBe(base); // shadow 先行：字节级不裁剪
    expect(embed).toHaveBeenCalledTimes(8); // 8 锚全打分（shadow 报告升级输入）
    const shadow = warns.filter((w) => w.includes("soul-anchor-select"));
    expect(shadow).toHaveLength(1);
    expect(shadow[0]).toContain("rows=8");
    expect(shadow[0]).toContain("maxRows=5");
    expect(shadow[0]).toMatch(/锚6\(1\.000\)/); // 逐锚分形态（偶数号=1.000）
    expect(shadow[0]).toMatch(/锚7\(0\.000\)/);
  });

  it("rows ≤ maxRows → 结构性零 embed 调用（打分不触发）", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => themed(i));
    const embed = stubEmbedder();
    const { warns, logger } = spyLogger();
    await buildSoulPrefix(
      makeStore(rows),
      { ...TENANT, userId: "u-lt" },
      logger,
      {
        anchorSelect: {
          maxRows: 5,
          scorer: { enabled: false, threshold: 0, queryEmbedding: new Float32Array([1, 0]), embedder: embed },
        },
      },
    );
    expect(embed).not.toHaveBeenCalled();
    expect(warns.filter((w) => w.includes("soul-anchor-select"))).toHaveLength(0);
  });

  it("shadow 无 query 向量 → 报告回退 #29 既有形态（清单前缀，无逐锚分）", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => themed(i));
    const embed = stubEmbedder();
    const { warns, logger } = spyLogger();
    await buildSoulPrefix(
      makeStore(rows),
      { ...TENANT, userId: "u-nq" },
      logger,
      { anchorSelect: { maxRows: 5, scorer: { enabled: false, threshold: 0, embedder: embed } } },
    );
    const shadow = warns.filter((w) => w.includes("soul-anchor-select"));
    expect(shadow).toHaveLength(1);
    expect(shadow[0]).toContain("锚7"); // 原形态：清单快照
    expect(shadow[0]).not.toMatch(/锚7\(0\.\d{3}\)/);
  });

  it("转正（enabled=true）：threshold 硬门+top-K 重排渲染行；不触发 shadow 报告", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => themed(i));
    const embed = stubEmbedder();
    const { warns, logger } = spyLogger();
    const out = await buildSoulPrefix(
      makeStore(rows),
      { ...TENANT, userId: "u-on" },
      logger,
      {
        anchorSelect: {
          maxRows: 5,
          scorer: { enabled: true, threshold: 0.5, queryEmbedding: new Float32Array([1, 0]), embedder: embed },
        },
      },
    );
    expect(warns.filter((w) => w.includes("soul-anchor-select"))).toHaveLength(0);
    // 偶数号锚 score=1 过门且并列保 value_id 声明序；奇数号 score=0 被硬门滤除（逐锚列表行聚合）
    const anchorLine = out.split("\n").filter((l) => l.startsWith("- 锚")).map((l) => l.slice(2)).join("\n");
    expect(anchorLine).toBeDefined();
    expect(anchorLine).toContain("锚0");
    expect(anchorLine).toContain("锚6");
    for (const odd of ["锚1", "锚3", "锚5", "锚7"]) expect(anchorLine).not.toContain(odd);
    expect(anchorLine!.match(/锚\d/g)).toHaveLength(4);
  });

  it("转正但 embedder/query 缺席 → 回退现状（全行渲染零裁剪，不抛错）", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => themed(i));
    const base = await buildSoulPrefix(makeStore(rows), { ...TENANT, userId: "u-base2" }, undefined, {});
    const out = await buildSoulPrefix(
      makeStore(rows),
      { ...TENANT, userId: "u-fb" },
      undefined,
      { anchorSelect: { maxRows: 5, scorer: { enabled: true, threshold: 0.5 } } },
    );
    expect(out).toBe(base);
  });

  it("缺省（未配置 scorer）→ 逐位现状 golden（含 shadow 报告不升级）", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => themed(i));
    const base = await buildSoulPrefix(makeStore(rows), { ...TENANT, userId: "u-base3" }, undefined, {});
    const { warns, logger } = spyLogger();
    const out = await buildSoulPrefix(
      makeStore(rows),
      { ...TENANT, userId: "u-def" },
      logger,
      { anchorSelect: { maxRows: 5 } },
    );
    expect(out).toBe(base);
    const shadow = warns.filter((w) => w.includes("soul-anchor-select"));
    expect(shadow).toHaveLength(1);
    expect(shadow[0]).not.toMatch(/锚7\(0\.\d{3}\)/); // 无向量→原形态
  });
});

describe("#42 审查加固（降级自审 F1/F2/F3）", () => {
  beforeEach(() => {
    resetAnchorVectorCacheForTest();
    resetSoulScorerMisconfigWarnForTest();
  });

  it("F2：转正路 embedder 拒绝 → 非致命回退未选择现状（渲染逐位）+ warn，不抛错", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => themed(i));
    const base = await buildSoulPrefix(makeStore(rows), { ...TENANT, userId: "u-base4" }, undefined, {});
    const embed: AnchorEmbedder = vi.fn(async () => {
      throw new Error("embed service down");
    });
    const { warns, logger } = spyLogger();
    const out = await buildSoulPrefix(
      makeStore(rows),
      { ...TENANT, userId: "u-f2a" },
      logger,
      {
        anchorSelect: {
          maxRows: 5,
          scorer: { enabled: true, threshold: 0.5, queryEmbedding: new Float32Array([1, 0]), embedder: embed },
        },
      },
    );
    expect(out).toBe(base); // 回退未选择=全行渲染
    expect(warns.some((w) => w.includes("score failed"))).toBe(true);
  });

  it("F2：shadow 路 embedder 拒绝 → 回退 #29 原形态报告（清单快照）+ warn，不抛错", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => themed(i));
    const embed: AnchorEmbedder = vi.fn(async () => {
      throw new Error("embed service down");
    });
    const { warns, logger } = spyLogger();
    await buildSoulPrefix(
      makeStore(rows),
      { ...TENANT, userId: "u-f2b" },
      logger,
      {
        anchorSelect: {
          maxRows: 5,
          scorer: { enabled: false, threshold: 0, queryEmbedding: new Float32Array([1, 0]), embedder: embed },
        },
      },
    );
    const shadow = warns.filter((w) => w.includes("soul-anchor-select"));
    expect(shadow).toHaveLength(1);
    expect(shadow[0]).toContain("转正待 D9/ADR"); // 原形态报告
    expect(shadow[0]).not.toMatch(/锚7\(0\.\d{3}\)/);
    expect(warns.some((w) => w.includes("shadow score failed"))).toBe(true);
  });

  it("F3：enabled=true 但向量面缺席 → 进程内告警一次 + 现状渲染；二次渲染不再告警", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => themed(i));
    const base = await buildSoulPrefix(makeStore(rows), { ...TENANT, userId: "u-base5" }, undefined, {});
    const { warns, logger } = spyLogger();
    const out1 = await buildSoulPrefix(
      makeStore(rows),
      { ...TENANT, userId: "u-f3a" },
      logger,
      { anchorSelect: { maxRows: 5, scorer: { enabled: true, threshold: 0.5 } } },
    );
    expect(out1).toBe(base);
    expect(warns.filter((w) => w.includes("enabled=true but"))).toHaveLength(1);
    const second = spyLogger();
    const out2 = await buildSoulPrefix(
      makeStore(rows),
      { ...TENANT, userId: "u-f3b" },
      second.logger,
      { anchorSelect: { maxRows: 5, scorer: { enabled: true, threshold: 0.5 } } },
    );
    expect(out2).toBe(base);
    expect(second.warns.filter((w) => w.includes("enabled=true but"))).toHaveLength(0); // once-per-process
  });

  it("F1：provider 懒解析——enabled=true 无显式向量时 provider 供向量 → 选择生效", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => themed(i));
    const embed = stubEmbedder();
    const provider = vi.fn(async () => new Float32Array([1, 0]));
    const out = await buildSoulPrefix(
      makeStore(rows),
      { ...TENANT, userId: "u-f1a" },
      undefined,
      {
        anchorSelect: {
          maxRows: 5,
          scorer: { enabled: true, threshold: 0.5, queryEmbeddingProvider: provider, embedder: embed },
        },
      },
    );
    expect(provider).toHaveBeenCalledTimes(1);
    const anchorLine = out.split("\n").filter((l) => l.startsWith("- 锚")).map((l) => l.slice(2)).join("\n");
    expect(anchorLine).toBeDefined();
    expect(anchorLine).toContain("锚0");
    expect(anchorLine).not.toContain("锚1"); // provider 向量生效=硬门滤除正交锚
  });

  it("F1：provider 解析失败 → 转正回退现状 + F3 一次性告警 + 零打分", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => themed(i));
    const base = await buildSoulPrefix(makeStore(rows), { ...TENANT, userId: "u-base6" }, undefined, {});
    const embed = stubEmbedder();
    const provider = vi.fn(async () => undefined);
    const { warns, logger } = spyLogger();
    const out = await buildSoulPrefix(
      makeStore(rows),
      { ...TENANT, userId: "u-f1b" },
      logger,
      {
        anchorSelect: {
          maxRows: 5,
          scorer: { enabled: true, threshold: 0.5, queryEmbeddingProvider: provider, embedder: embed },
        },
      },
    );
    expect(out).toBe(base);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(embed).not.toHaveBeenCalled(); // 无查询向量→不打分
    expect(warns.filter((w) => w.includes("enabled=true but"))).toHaveLength(1);
  });

  it("F1 零成本保证：enabled=false 且 rows≤maxRows → provider/embedder 零调用", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => themed(i));
    const embed = stubEmbedder();
    const provider = vi.fn(async () => new Float32Array([1, 0]));
    await buildSoulPrefix(
      makeStore(rows),
      { ...TENANT, userId: "u-f1c" },
      undefined,
      {
        anchorSelect: {
          maxRows: 5,
          scorer: { enabled: false, threshold: 0, queryEmbeddingProvider: provider, embedder: embed },
        },
      },
    );
    expect(provider).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
  });

  it("F1：shadow 报告触发时 provider 才解析 → 逐锚分升级形态", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => themed(i));
    const embed = stubEmbedder();
    const provider = vi.fn(async () => new Float32Array([1, 0]));
    const { warns, logger } = spyLogger();
    await buildSoulPrefix(
      makeStore(rows),
      { ...TENANT, userId: "u-f1d" },
      logger,
      {
        anchorSelect: {
          maxRows: 5,
          scorer: { enabled: false, threshold: 0, queryEmbeddingProvider: provider, embedder: embed },
        },
      },
    );
    expect(provider).toHaveBeenCalledTimes(1);
    const shadow = warns.filter((w) => w.includes("soul-anchor-select"));
    expect(shadow).toHaveLength(1);
    expect(shadow[0]).toMatch(/锚6\(1\.000\)/); // 升级形态
  });

  it("cacheKey：enabled=true 时 queryText 指纹换键——同 queryText 缓存命中零重打分，异 queryText 重打分", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => themed(i));
    const embed = stubEmbedder();
    // provider 返回向量随 queryText 变（q1=[1,0] 命中正向锚，q2=[0,1] 命中另一组）——
    // 使「异 queryText 重打分」产生可观察的行为差（选择串不同），而非仅计数断言。
    let currentQv = new Float32Array([1, 0]);
    const provider = vi.fn(async () => currentQv);
    const mk = (qt: string) => {
      currentQv = qt === "q1" ? new Float32Array([1, 0]) : new Float32Array([0, 1]);
      return buildSoulPrefix(
        makeStore(rows),
        { ...TENANT, userId: "u-ck" },
        undefined,
        {
          anchorSelect: {
            maxRows: 5,
            scorer: { enabled: true, threshold: 0.5, queryText: qt, queryEmbeddingProvider: provider, embedder: embed },
          },
        },
      );
    };
    const blockQ1a = await mk("q1");
    const blockQ1b = await mk("q1"); // 同指纹→缓存命中
    const blockQ2 = await mk("q2"); // 异指纹→重渲染
    expect(provider).toHaveBeenCalledTimes(2); // 每次真实渲染解析一次（缓存命中路不解析）
    // embed×8 仅 render1：render3 重打分但 #29 锚向量缓存按 desc 命中零 embed（缓存语义非缺陷）
    expect(embed).toHaveBeenCalledTimes(8);
    expect(blockQ1b).toBe(blockQ1a); // 同 queryText → 同串（缓存命中）
    expect(blockQ2).not.toBe(blockQ1a); // 异 queryText → 指纹换键 → 重打分产生不同选择串（陈旧缓存未复活）
  });

  it("I-4（#42 审查）：退化 qv（零范数）不通过可用门 → 回退现状（价值锚行不消失）+ F3 告警", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => themed(i));
    const base = await buildSoulPrefix(makeStore(rows), { ...TENANT, userId: "u-base7" }, undefined, {});
    const embed = stubEmbedder();
    const { warns, logger } = spyLogger();
    const out = await buildSoulPrefix(
      makeStore(rows),
      { ...TENANT, userId: "u-i4" },
      logger,
      {
        anchorSelect: {
          maxRows: 5,
          scorer: { enabled: true, threshold: 0.5, queryEmbedding: new Float32Array([0, 0]), embedder: embed },
        },
      },
    );
    expect(out).toBe(base); // threshold>0 全滤除=锚行消失的数据损失面 → 按缺席回退
    expect(embed).not.toHaveBeenCalled(); // 退化向量不打分
    expect(warns.filter((w) => w.includes("enabled=true but"))).toHaveLength(1);
  });

  it("M-4（#42 审查）：enabled=true 向量缺席的回退报告措辞 ≠ 缺省同形（标注转正已开）", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => themed(i));
    const { warns, logger } = spyLogger();
    await buildSoulPrefix(
      makeStore(rows),
      { ...TENANT, userId: "u-m4" },
      logger,
      { anchorSelect: { maxRows: 5, scorer: { enabled: true, threshold: 0.5 } } },
    );
    const shadow = warns.filter((w) => w.includes("soul-anchor-select"));
    expect(shadow).toHaveLength(1);
    expect(shadow[0]).toContain("转正已开但向量缺席回退");
    expect(shadow[0]).not.toContain("转正待 D9/ADR");
  });

  it("M-1 回归锁（#42 审查）：预算截断使 budgeted<decoratedPairs → 升级报告不触发（原形态+零打分）", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => themed(i));
    const embed = stubEmbedder();
    const { warns, logger } = spyLogger();
    await buildSoulPrefix(
      makeStore(rows),
      { ...TENANT, userId: "u-m1" },
      logger,
      {
        anchorSelect: {
          maxRows: 5,
          scorer: { enabled: false, threshold: 0, queryEmbedding: new Float32Array([1, 0]), embedder: embed },
        },
        budgetAnchorChars: 150, // 探针实证：8 行截至 6 行（>maxRows=5 且 <8）=守卫分支（140 会截到 5 行=报告门不触发）
      },
    );
    expect(embed).not.toHaveBeenCalled(); // 预算截断后选择≠未选择 → 逐锚分报告失效回退原形态
    const shadow = warns.filter((w) => w.includes("soul-anchor-select"));
    expect(shadow).toHaveLength(1);
    expect(shadow[0]).toContain("转正待 D9/ADR");
    expect(shadow[0]).not.toMatch(/锚\d\(0\.\d{3}\)/);
  });
});
