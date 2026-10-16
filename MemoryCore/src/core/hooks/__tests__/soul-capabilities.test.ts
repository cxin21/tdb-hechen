/**
 * #32（R5）能力自述段测试：只读派生「## 我能做什么」置身份段尾。
 * 合同：缺省不渲染=逐位现状；渲染行=传入清单（一致性，顺序保持）；
 * 零落库（无任何 store 写路径调用）；cacheKey 含清单指纹（同数据不同清单不串缓存）。
 */
import { describe, expect, it } from "vitest";
import { buildSoulPrefix } from "../soul-assembler.js";

const TENANT = { teamId: "tcap", userId: "u1", agentId: "a1" };

function makeStore(slots: Array<{ slot: string; content: string }>) {
  return { readCore: async () => slots, listValues: async () => [] } as never;
}

const SLOTS = [{ slot: "identity", content: "我是测试者。" }];
const CAPS = ["检索记忆", "写入记忆", "回答问题", "运行探针", "生成报告", "第六项应保留"];

describe("#32 能力自述段", () => {
  it("缺省（未传 capabilities）→ 渲染逐位不变（无我能做什么段）", async () => {
    const base = await buildSoulPrefix(makeStore(SLOTS), { ...TENANT, userId: "u-base" }, undefined, {});
    expect(base).not.toContain("我能做什么");
  });

  it("传入清单 → 逐行 1:1 渲染（顺序保持、置身份段尾）", async () => {
    const out = await buildSoulPrefix(makeStore(SLOTS), { ...TENANT, userId: "u-cap" }, undefined, { capabilities: CAPS });
    expect(out).toContain("## 我能做什么");
    for (const c of CAPS) expect(out).toContain(`- ${c}`); // 一致性合同：全量逐行
    const capIdx = out.indexOf("## 我能做什么");
    const redlineIdx = out.indexOf("## 不可逾越");
    const whoIdx = out.indexOf("## 此刻的你");
    expect(whoIdx).toBeGreaterThan(-1);
    expect(capIdx).toBeGreaterThan(redlineIdx > -1 ? redlineIdx : whoIdx); // 段尾位置
    expect(out.indexOf("</soul-identity>")).toBeGreaterThan(capIdx);
  });

  it("cacheKey 含清单指纹：同租户同数据不同清单 → 不同渲染；同清单 → 缓存命中同串", async () => {
    const a = await buildSoulPrefix(makeStore(SLOTS), TENANT, undefined, { capabilities: ["甲能力"] });
    const b = await buildSoulPrefix(makeStore(SLOTS), TENANT, undefined, { capabilities: ["乙能力"] });
    expect(a).not.toBe(b);
    expect(a).toContain("甲能力");
    expect(b).not.toContain("甲能力");
    const a2 = await buildSoulPrefix(makeStore(SLOTS), TENANT, undefined, { capabilities: ["甲能力"] });
    expect(a2).toBe(a); // 缓存命中不串
  });
});
