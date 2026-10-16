/**
 * #31（R5）：对抗式身份探针 runner —— 规则层断言（CI 可断言部分）。
 *
 * 合同（r5-31.md）：
 *   - 规则层：红线触发词、锚引用存在性、块完整性 → 确定性断言（本文件）
 *   - judge 层：人格一致总体判断 → shadow 定标后转正（不在本套件，r5-31 修正 2）
 *   - CI 分层：`pnpm run test:soul-probes:redline`（PR 门，红线子集）/
 *     `pnpm run test:soul-probes`（全量 50 条，夜间）
 *
 * 每用例独立租户（soulPrefixCache 模块级缓存实录）；探针清单见
 * soul-identity-probes.fixtures.ts（50 条，类别×难度层统计在 probeCoverage）。
 */
import { describe, expect, it } from "vitest";
import * as assembler from "../soul-assembler.js";
import { IDENTITY_PROBES, probeCoverage, type IdentityProbe } from "./soul-identity-probes.fixtures.js";

const { buildSoulPrefix, computeSoulVersion } = assembler;

const mkTenant = (n: string) => ({ teamId: "t1", userId: "u1", agentId: `p31-${n}` });

function makeStore(probe: IdentityProbe) {
  return {
    readCore: async () => probe.slots ?? [],
    listValues: async () => probe.rows,
  } as never;
}

function assertProbe(out: string, probe: IdentityProbe): void {
  for (const s of probe.expectContains ?? []) {
    expect(out, `[${probe.id}] 应包含`).toContain(s);
  }
  for (const s of probe.expectNotContains ?? []) {
    expect(out, `[${probe.id}] 不应包含`).not.toContain(s);
  }
  for (const src of probe.expectRegex ?? []) {
    expect(out, `[${probe.id}] 应匹配 /${src}/`).toMatch(new RegExp(src));
  }
}

describe("红线子集（每次 PR 门，CI 分层）", () => {
  const redline = IDENTITY_PROBES.filter((p) => p.subset === "redline");
  it("红线子集非空且触发词断言成立", async () => {
    expect(redline.length).toBeGreaterThanOrEqual(8);
    for (const probe of redline) {
      const out = (await buildSoulPrefix(makeStore(probe), mkTenant(probe.id), undefined, probe.opts as never)) ?? "";
      assertProbe(out, probe);
    }
  });
});

describe("全量探针（夜间跑，50 条）", () => {
  it("探针集规模与覆盖面（≥50、induced 层 ≥10、类别 ≥6）", () => {
    const cov = probeCoverage();
    expect(cov.total).toBeGreaterThanOrEqual(50);
    expect(cov.byLayer.induced).toBeGreaterThanOrEqual(10);
    expect(Object.keys(cov.byCategory).length).toBeGreaterThanOrEqual(6);
  });

  for (const probe of IDENTITY_PROBES) {
    it(`${probe.id}（${probe.category}/${probe.layer}）`, async () => {
      const out =
        (await buildSoulPrefix(makeStore(probe), mkTenant(probe.id), undefined, probe.opts as never)) ?? "";
      assertProbe(out, probe);
    });
  }

  it("P14/P50 指纹稳定性：同内容跨租户 soulVersion 一致（KV 稳定性规则）", () => {
    const slots = [{ slot: "self_identity", content: "我是测试主体" }];
    const rows = [{ value_id: "v1", label: "指纹锚", weight: 0.5, valence: 1, state: "active", node_type: "theme", attrs_json: JSON.stringify({ description: "内容定指纹。" }) }];
    const verA = computeSoulVersion(slots, rows, undefined);
    const verB = computeSoulVersion(slots, rows, undefined);
    expect(verA).toBe(verB);
    expect(verA).toMatch(/^sv-[0-9a-f]{8}$/);
  });
});
