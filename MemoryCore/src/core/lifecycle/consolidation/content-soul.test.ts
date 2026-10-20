/**
 * Batch C C-a（#77）：bindSoulAtWrite —— 写链 soul 合标统一（patchSoulFromContent 应用
 * + occurred_at 最小兜底=createdAt||now）。取证：生产 l1_records work_fact 397 条中 340 条
 * occurred_at 空，全部来自 reflection 写卡链（scene_name=reflection 且 metadata.reflection=1，
 * 340/340 空）——写链直调 store.upsertL1 绕过 l1-writer.ts:330 choke point。
 * 纪律：只填空字段（不猜内容时间、不覆盖既有值）；occurred_at 兜底=真实记录时刻，非伪造。
 */
import { describe, it, expect } from "vitest";
import { patchSoulFromContent, bindSoulAtWrite } from "./content-soul.js";

describe("Batch C C-a bindSoulAtWrite（写链 soul 合标统一）", () => {
  it("无 occurred_at + 无时间词 + 有 createdAt → occurred_at=createdAt（真实记录时刻）", () => {
    const rec: Record<string, unknown> = { content: "用户每周五做复盘", createdAt: "2026-10-20T08:00:00.000Z" };
    bindSoulAtWrite(rec as never);
    expect(rec.occurred_at).toBe("2026-10-20T08:00:00.000Z");
  });

  it("无 occurred_at + 无时间词 + 无 createdAt → occurred_at≈now（ISO 可解析）", () => {
    const rec: Record<string, unknown> = { content: "用户偏好结论先行" };
    bindSoulAtWrite(rec as never);
    expect(typeof rec.occurred_at).toBe("string");
    expect(Number.isNaN(Date.parse(String(rec.occurred_at)))).toBe(false);
  });

  it("已有 occurred_at → 不动（幂等；bindSoulAtWrite 只填空字段）", () => {
    const rec: Record<string, unknown> = { content: "用户每周五做复盘", occurred_at: "2026-10-01T00:00:00.000Z", createdAt: "2026-10-20T08:00:00.000Z" };
    bindSoulAtWrite(rec as never);
    expect(rec.occurred_at).toBe("2026-10-01T00:00:00.000Z");
  });

  it("内容含相对时间词（昨天）→ parse 值优先于 createdAt 兜底", () => {
    const rec: Record<string, unknown> = { content: "昨天用户确认了召回精度方案", createdAt: "2026-10-20T08:00:00.000Z" };
    bindSoulAtWrite(rec as never);
    expect(typeof rec.occurred_at).toBe("string");
    expect(String(rec.occurred_at)).not.toBe("2026-10-20T08:00:00.000Z");
    expect(Number.isNaN(Date.parse(String(rec.occurred_at)))).toBe(false);
  });

  it("情感只填空：内容含焦虑 → valence=-0.6/arousal=0.9；已有 valence → 不动", () => {
    const rec: Record<string, unknown> = { content: "用户对 CI 抖动感到焦虑", createdAt: "2026-10-20T08:00:00.000Z" };
    bindSoulAtWrite(rec as never);
    expect(rec.valence).toBe(-0.6);
    expect(rec.arousal).toBe(0.9);
    const rec2: Record<string, unknown> = { content: "用户对 CI 抖动感到焦虑", valence: 0.8, arousal: 0.1, createdAt: "2026-10-20T08:00:00.000Z" };
    bindSoulAtWrite(rec2 as never);
    expect(rec2.valence).toBe(0.8);
    expect(rec2.arousal).toBe(0.1);
  });

  it("certainty 只填空 → observed", () => {
    const rec: Record<string, unknown> = { content: "用户确认方案", createdAt: "2026-10-20T08:00:00.000Z" };
    bindSoulAtWrite(rec as never);
    expect(rec.certainty).toBe("observed");
  });

  it("空 content / 非 string content 不炸（透传兜底 occurred_at）", () => {
    const rec: Record<string, unknown> = { content: "", createdAt: "2026-10-20T08:00:00.000Z" };
    bindSoulAtWrite(rec as never);
    expect(rec.occurred_at).toBe("2026-10-20T08:00:00.000Z");
    const rec2: Record<string, unknown> = { createdAt: "2026-10-20T08:00:00.000Z" };
    bindSoulAtWrite(rec2 as never);
    expect(rec2.occurred_at).toBe("2026-10-20T08:00:00.000Z");
  });
});

describe("patchSoulFromContent 回归锚（既有行为保真）", () => {
  it("既有语义：只返回 patch（不就地改）；空字段全填/已有不动", () => {
    const p1 = patchSoulFromContent("昨天用户很兴奋地确认了方案", {});
    expect(p1.occurred_at).toBeDefined();
    expect(p1.valence).toBe(0.8);
    const p2 = patchSoulFromContent("内容", { occurred_at: "2026-01-01T00:00:00.000Z", valence: 0.8 });
    expect(p2.occurred_at).toBeUndefined();
    expect(p2.valence).toBeUndefined();
  });
});
