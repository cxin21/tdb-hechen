/**
 * D-3 重设计（2026-11-04 定案）：sensitivity = 「不外泄 / 不注入」门 · RED 套件。
 *
 * 语义（用户拍板）：sensitivity !== 'none' 的行**不是**排序降权对象，而是
 * **不该出现在会被第三方看到的上下文里**的内容——
 *   - 个人单聊 / 私有上下文 → 允许注入；
 *   - 群聊、团队/多人共享、显式 external → 一律不注入；
 *   - 上下文未声明（undefined / 只声明一半 / 运行期脏值）→ **不注入**（fail-closed）。
 *
 * 本套件只测纯函数（零 DB / 零时钟 / 零副作用），不含任何配置开关——
 * 该门是标准行为，不是可配置项。
 */
import { describe, it, expect } from "vitest";
import {
  SENSITIVE_AUDIENCE_ALLOWLIST,
  countBlockedByReason,
  decideDerivedInjection,
  decideSensitivityInjection,
  isSensitiveRecord,
  partitionBySensitivity,
  resolveAudience,
  type RecallAudienceContext,
} from "../sensitivity-policy.js";

/** 个人单聊 / 私有：唯一放行的可见性组合。 */
const PRIVATE_CTX: RecallAudienceContext = { chat: "direct", sharing: "private" };
const GROUP_CTX: RecallAudienceContext = { chat: "group", sharing: "private" };
const SHARED_CTX: RecallAudienceContext = { chat: "direct", sharing: "shared" };
const EXTERNAL_CTX: RecallAudienceContext = { chat: "direct", sharing: "external" };

describe("D-3 门 · 白名单常量（唯一放行面 = private）", () => {
  it("白名单恰好只有 'private' 一项（新增可见性默认拦截，必须显式加白）", () => {
    expect([...SENSITIVE_AUDIENCE_ALLOWLIST]).toEqual(["private"]);
  });
});

describe("D-3 门 · resolveAudience（deny 优先 + 未声明即 undeclared）", () => {
  it("单聊 + 私有 → private", () => {
    expect(resolveAudience(PRIVATE_CTX)).toBe("private");
  });
  it("群聊 → group；团队共享 → shared；外发 → external", () => {
    expect(resolveAudience(GROUP_CTX)).toBe("group");
    expect(resolveAudience(SHARED_CTX)).toBe("shared");
    expect(resolveAudience(EXTERNAL_CTX)).toBe("external");
  });
  it("二者冲突时取更严格的那个（deny 优先）：群聊+外发 → external；群聊+团队 → shared", () => {
    expect(resolveAudience({ chat: "group", sharing: "external" })).toBe("external");
    expect(resolveAudience({ chat: "group", sharing: "shared" })).toBe("shared");
  });
  it("undefined / null / 空对象 / 只声明一半 → undeclared（fail-closed，不允许默认私有）", () => {
    expect(resolveAudience(undefined)).toBe("undeclared");
    expect(resolveAudience(null)).toBe("undeclared");
    expect(resolveAudience({})).toBe("undeclared");
    expect(resolveAudience({ chat: "direct" })).toBe("undeclared");
    expect(resolveAudience({ sharing: "private" })).toBe("undeclared");
  });
  it("运行期脏值（JSON body 被改坏）→ undeclared，绝不猜成 private", () => {
    expect(resolveAudience({ chat: "dm", sharing: "private" } as never)).toBe("undeclared");
    expect(resolveAudience({ chat: "direct", sharing: "chill" } as never)).toBe("undeclared");
  });
});

describe("D-3 门 · isSensitiveRecord（确定性 + fail-closed 归一）", () => {
  it("none / 缺失 / null → 非敏感（历史行无标注按 none：写入侧已合标 undef→none）", () => {
    expect(isSensitiveRecord({ sensitivity: "none" })).toBe(false);
    expect(isSensitiveRecord({})).toBe(false);
    expect(isSensitiveRecord({ sensitivity: null })).toBe(false);
    expect(isSensitiveRecord({ sensitivity: undefined })).toBe(false);
  });
  it("health / finance / relationship → 敏感", () => {
    expect(isSensitiveRecord({ sensitivity: "health" })).toBe(true);
    expect(isSensitiveRecord({ sensitivity: "finance" })).toBe(true);
    expect(isSensitiveRecord({ sensitivity: "relationship" })).toBe(true);
  });
  it("大小写/空白归一：' NONE ' 非敏感；' HEALTH ' 敏感", () => {
    expect(isSensitiveRecord({ sensitivity: " NONE " })).toBe(false);
    expect(isSensitiveRecord({ sensitivity: " HEALTH " })).toBe(true);
  });
  it("枚举外的脏值 / 空串 → 敏感（fail-closed：读侧不认识就当敏感，绝不默认放行）", () => {
    expect(isSensitiveRecord({ sensitivity: "secret" })).toBe(true);
    expect(isSensitiveRecord({ sensitivity: "" })).toBe(true);
  });
});

describe("D-3 门 · 单条裁决：none 行任何上下文都注入", () => {
  it.each([
    ["private", PRIVATE_CTX],
    ["group", GROUP_CTX],
    ["shared", SHARED_CTX],
    ["external", EXTERNAL_CTX],
    ["undeclared", undefined],
  ])("none 行在 %s 上下文注入（reason=not-sensitive）", (_label, ctx) => {
    const d = decideSensitivityInjection({ sensitivity: "none" }, ctx as RecallAudienceContext | undefined);
    expect(d.injectable).toBe(true);
    expect(d.sensitivity).toBe("none");
    expect(d.blockedBy).toBeUndefined();
  });
  it("缺失 sensitivity 的历史行与 none 等价（任何上下文都注入）", () => {
    expect(decideSensitivityInjection({}, GROUP_CTX).injectable).toBe(true);
    expect(decideSensitivityInjection({}, undefined).injectable).toBe(true);
  });
});

describe("D-3 门 · 单条裁决：敏感行只在私有上下文注入", () => {
  it("health + 个人单聊 → 注入（唯一放行路径）", () => {
    const d = decideSensitivityInjection({ sensitivity: "health" }, PRIVATE_CTX);
    expect(d.injectable).toBe(true);
    expect(d.sensitivity).toBe("health");
    expect(d.audience).toBe("private");
    expect(d.blockedBy).toBeUndefined();
  });
  it("health + 群聊 → 拦截（blockedBy=group）", () => {
    const d = decideSensitivityInjection({ sensitivity: "health" }, GROUP_CTX);
    expect(d.injectable).toBe(false);
    expect(d.blockedBy).toBe("group");
  });
  it("finance + 团队/多人共享 → 拦截（blockedBy=shared）", () => {
    const d = decideSensitivityInjection({ sensitivity: "finance" }, SHARED_CTX);
    expect(d.injectable).toBe(false);
    expect(d.blockedBy).toBe("shared");
  });
  it("relationship + 显式外发 → 拦截（blockedBy=external）", () => {
    const d = decideSensitivityInjection({ sensitivity: "relationship" }, EXTERNAL_CTX);
    expect(d.injectable).toBe(false);
    expect(d.blockedBy).toBe("external");
  });
  it("上下文未声明 / 只声明一半 → 拦截（blockedBy=undeclared，安全侧：证明不了私有就不注入）", () => {
    for (const ctx of [undefined, null, {}, { chat: "direct" }, { sharing: "private" }]) {
      const d = decideSensitivityInjection({ sensitivity: "health" }, ctx as never);
      expect(d.injectable).toBe(false);
      expect(d.blockedBy).toBe("undeclared");
      expect(d.audience).toBe("undeclared");
    }
  });
  it("枚举外脏值 'secret' 在私有上下文也拦截（blockedBy=unclassified：标注不可信，宁缺毋滥）", () => {
    const d = decideSensitivityInjection({ sensitivity: "secret" }, PRIVATE_CTX);
    expect(d.injectable).toBe(false);
    expect(d.sensitivity).toBe("unclassified");
    expect(d.blockedBy).toBe("unclassified");
  });
});

describe("D-3 门 · 批量分流（保序、不改入参）", () => {
  it("混合池：none 全留、敏感行按上下文分流并带原因，顺序不变", () => {
    type Row = { id: string; sensitivity?: string | null };
    const rows: readonly Readonly<Row>[] = Object.freeze([
      Object.freeze({ id: "a", sensitivity: "none" }),
      Object.freeze({ id: "b", sensitivity: "health" }),
      Object.freeze({ id: "c", sensitivity: "finance" }),
      Object.freeze({ id: "d" }),
    ]);
    const priv = partitionBySensitivity(rows, PRIVATE_CTX);
    expect(priv.injectable.map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
    expect(priv.blocked).toEqual([]);

    const group = partitionBySensitivity(rows, GROUP_CTX);
    expect(group.injectable.map((r) => r.id)).toEqual(["a", "d"]);
    expect(group.blocked.map((b) => [b.item.id, b.decision.blockedBy])).toEqual([
      ["b", "group"],
      ["c", "group"],
    ]);
    // 入参未被修改（deep-freeze 未抛 = 纯函数零副作用）
    expect(rows.map((r) => r.sensitivity)).toEqual(["none", "health", "finance", undefined]);
  });
  it("countBlockedByReason：按原因计数（journal 可观测位，只数非 0 项）", () => {
    const rows = [
      { id: "a", sensitivity: "none" },
      { id: "b", sensitivity: "health" },
      { id: "c", sensitivity: "finance" },
      { id: "d", sensitivity: "relationship" },
      { id: "e", sensitivity: "secret" },
    ];
    const counts = countBlockedByReason(partitionBySensitivity(rows, GROUP_CTX));
    expect(counts).toEqual({ group: 3, unclassified: 1 });
    // 私有上下文：敏感行全放行，但腐坏行（unclassified）仍拦——只剩这一项
    expect(countBlockedByReason(partitionBySensitivity(rows, PRIVATE_CTX))).toEqual({ unclassified: 1 });
    // 干净池 + 私有上下文 → 空对象（不写 0 值，journal 不产噪声）
    expect(countBlockedByReason(partitionBySensitivity(rows.slice(0, 4), PRIVATE_CTX))).toEqual({});
  });

  it("同一输入重复调用逐位相同（确定性）", () => {
    const rows = [{ id: "x", sensitivity: "relationship" }];
    expect(JSON.stringify(partitionBySensitivity(rows, EXTERNAL_CTX))).toBe(
      JSON.stringify(partitionBySensitivity(rows, EXTERNAL_CTX)),
    );
  });
});

/**
 * P0-1（2026-11-04 L1 属性复核）：结论层第三道门——L2 场景块摘要不是某一行原文，
 * 而是 N 行蒸馏聚合，只能沿 derived_from 边回到派生行判定"这段聚合里有没有敏感内容"。
 */
describe("P0-1 结论层门 · decideDerivedInjection（派生来源画像）", () => {
  it("来源含敏感行：private 放行，其余一律拦（原因 derived-sensitive）", () => {
    const stat = { targets: 12, sensitive: 2 };
    expect(decideDerivedInjection(stat, PRIVATE_CTX)).toEqual({ injectable: true, audience: "private" });
    for (const ctx of [GROUP_CTX, SHARED_CTX, EXTERNAL_CTX, undefined]) {
      const d = decideDerivedInjection(stat, ctx);
      expect(d.injectable).toBe(false);
      expect(d.blockedBy).toBe("derived-sensitive");
    }
  });

  it("来源干净（有溯源且敏感数=0）：任何上下文都放行", () => {
    for (const ctx of [PRIVATE_CTX, GROUP_CTX, SHARED_CTX, EXTERNAL_CTX, undefined]) {
      expect(decideDerivedInjection({ targets: 30, sensitive: 0 }, ctx).injectable).toBe(true);
    }
  });

  it("溯源不可判定（无画像 / targets=0 即来源全归档）：非 private 按 derived-unknown 拦，private 放行", () => {
    for (const stat of [undefined, null, { targets: 0, sensitive: 0 }]) {
      expect(decideDerivedInjection(stat, PRIVATE_CTX)).toEqual({ injectable: true, audience: "private" });
      const d = decideDerivedInjection(stat, GROUP_CTX);
      expect(d.injectable).toBe(false);
      expect(d.blockedBy).toBe("derived-unknown");
    }
  });

  it("两种拦截原因互斥：有敏感来源时不得降级成 derived-unknown", () => {
    expect(decideDerivedInjection({ targets: 5, sensitive: 1 }, EXTERNAL_CTX).blockedBy).toBe("derived-sensitive");
    expect(decideDerivedInjection({ targets: 5, sensitive: 0 }, EXTERNAL_CTX).injectable).toBe(true);
  });

  it("确定性：同输入重复调用逐位相同", () => {
    const stat = { targets: 3, sensitive: 3 };
    expect(JSON.stringify(decideDerivedInjection(stat, SHARED_CTX))).toBe(
      JSON.stringify(decideDerivedInjection(stat, SHARED_CTX)),
    );
  });
});
