/**
 * #10 T4：soul 人格前缀三行注入预算（价值锚行/重要的人行/品格行）。
 * 现状：身份槽有预算（budgetSelfChars 600 / budgetIdentityChars 900，truncateByLines），
 * 三行锚列表 join("；") 无总长预算——theme maxTotal=15 满载 ≈700 字且随调参无界。
 * 方案：applyAnchorBudget 整锚粒度（超预算从尾丢整项，不截半句）；预算缺省 0=逐位现状
 * （config-first 铁律，放量在配置层）；缓存键含渲染参数指纹（同数据不同预算必须换缓存，
 * 否则旧渲染串复活）。
 */
import { describe, expect, it } from "vitest";
import { applyAnchorBudget, buildSoulPrefix } from "../soul-assembler.js";

const TENANT = { teamId: "tb", userId: "ub", agentId: "ab" };

function makeStore(rows: Array<Record<string, unknown>>, slots: Array<Record<string, string>> = []) {
  return {
    readCore: async () => slots,
    listValues: async () => rows,
  } as never;
}

const row = (o: { value_id: string; label: string; weight?: number; valence?: number | null; node_type?: string; attrs_json?: string; pinned?: boolean }) => ({
  value_id: o.value_id,
  label: o.label,
  weight: o.weight ?? 0.5,
  valence: o.valence ?? 1,
  state: "active",
  node_type: o.node_type ?? "theme",
  attrs_json: o.attrs_json ?? "{}",
});

const themed = (i: number) =>
  row({ value_id: `v${String(i).padStart(2, "0")}`, label: `锚${i}`, attrs_json: `{"description":"第${i}号锚的稳定描述句。"}` });

describe("applyAnchorBudget 单元", () => {
  it("预算内全保留", () => {
    const items = ["甲(w0.5)：一句。", "乙(w0.5)：两句。"];
    expect(applyAnchorBudget(items, 100)).toEqual(items);
  });
  it("超预算从尾丢整项（保 value_id 稳定序头部）", () => {
    const items = ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"];
    const kept = applyAnchorBudget(items, 21); // 10+1+10=21 恰好放前两个
    expect(kept).toEqual(["aaaaaaaaaa", "bbbbbbbbbb"]);
  });
  it("预算 0 = 现状（原样返回）", () => {
    const items = ["aaaaaaaaaa", "bbbbbbbbbb"];
    expect(applyAnchorBudget(items, 0)).toEqual(items);
  });
  it("首项即超预算 → 保首项整句（不截半句、不清空行）", () => {
    const items = ["a".repeat(50), "b"];
    expect(applyAnchorBudget(items, 10)).toEqual(["a".repeat(50)]);
  });
});

describe("#10 三行注入预算（buildSoulPrefix）", () => {
  it("15 锚满载 budgetAnchorChars=240 → 价值锚行 ≤240 字且保留头部锚、整锚不截半", async () => {
    const rows = Array.from({ length: 15 }, (_, i) => themed(i));
    const out = await buildSoulPrefix(makeStore(rows) as never, TENANT, undefined, { budgetAnchorChars: 240 });
    // 呈现层翻修（2026-10-16）：逐锚列表行——预算断言面=锚内容串（applyAnchorBudget join("；") 口径），
    // 与「- 」前缀/换行渲染解耦。
    const items = out.split("\n").filter((l) => l.startsWith("- 锚")).map((l) => l.slice(2));
    expect(items.length).toBeGreaterThan(0);
    const body = items.join("；");
    expect(body.length).toBeLessThanOrEqual(240);
    expect(body).toContain("锚0("); // 头部保留
    expect(body).not.toContain("锚14("); // 尾部丢弃
    for (const seg of items) expect(seg.endsWith("。")).toBe(true); // 整锚不截半
  });

  it("budgetAnchorChars=0 → 逐位现状（与无预算渲染逐字节一致）", async () => {
    const rows = Array.from({ length: 15 }, (_, i) => themed(i));
    const plain = await buildSoulPrefix(makeStore(rows) as never, { ...TENANT, userId: "u-plain" }, undefined, {});
    const zero = await buildSoulPrefix(makeStore(rows) as never, { ...TENANT, userId: "u-zero" }, undefined, { budgetAnchorChars: 0 });
    expect(zero).toBe(plain);
  });

  it("同租户同数据不同预算 → 缓存键含预算指纹（旧渲染串不复活）", async () => {
    const rows = Array.from({ length: 15 }, (_, i) => themed(i));
    const tight = await buildSoulPrefix(makeStore(rows) as never, TENANT, undefined, { budgetAnchorChars: 120 });
    const loose = await buildSoulPrefix(makeStore(rows) as never, TENANT, undefined, { budgetAnchorChars: 0 });
    expect(loose).not.toBe(tight);
    const looseBody = loose.split("\n").filter((l) => l.startsWith("- 锚")).map((l) => l.slice(2)).join("；");
    expect(looseBody).toContain("锚14(");
  });

  it("重要的人行 budgetPersonChars：从尾丢整人，头部保留", async () => {
    const rows = [
      row({ value_id: "p-a", label: "甲君", node_type: "person", attrs_json: '{"role":"同事","description":"甲君的稳定描述句。"}' }),
      row({ value_id: "p-b", label: "乙君", node_type: "person", attrs_json: '{"role":"朋友","description":"乙君的稳定描述句。"}' }),
    ];
    const out = await buildSoulPrefix(makeStore(rows) as never, TENANT, undefined, { budgetPersonChars: 30 });
    const body = out.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2)).join("；");
    expect(body.length).toBeLessThanOrEqual(30);
    expect(body).toContain("甲君"); // value_id 稳定序头部
    expect(body).not.toContain("乙君");
  });

  it("品格行 budgetCharacterChars：同构整锚预算", async () => {
    const rows = [
      row({ value_id: "c-a", label: "守诺", node_type: "character", attrs_json: '{"description":"承诺过的事追踪到闭环。"}' }),
      row({ value_id: "c-b", label: "严谨", node_type: "character", attrs_json: '{"description":"交付前逐项核对验收口径。"}' }),
    ];
    const out = await buildSoulPrefix(makeStore(rows) as never, TENANT, undefined, { characterTensionEnabled: true, budgetCharacterChars: 24 });
    const body = out.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2)).join("；");
    expect(body.length).toBeLessThanOrEqual(24);
    expect(body).toContain("守诺");
    expect(body).not.toContain("严谨");
  });
});
