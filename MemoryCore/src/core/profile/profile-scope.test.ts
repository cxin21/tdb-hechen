/**
 * R4-5 修复（P0，A6 四级贯通召回级）：L2/L3 profile scope 加 user 维度。
 *
 * 设计依据（第一性原理 + spec 对照）：
 * - spec §2.3：L2 场景块"内容主语=agent 会话场景 + 用户事实"；L3 结论卡片"内容主语=用户"。
 * - spec §10 D-R3-1（已登记缺陷）：跨 user 串味需修复（A6 四级贯通召回级）。
 * - spec §7-P3 拍板记录：品格随关系分化（经历库 per-三元组 team/user/agent），
 *   "同 agent 跨用户品格无共享——接受"——L3 也按三元组。
 * - 旧行为（profile-sync.ts 旧注释有意忽略 userId）在多用户 agent 下把 A 用户的
 *   身份事实注入 B 用户 soul 块（ev10 Q 租户 /recall 实证），违反多租户隔离铁律。
 *
 * 兼容：ctx 缺 userId（钩子无租户上下文路径）→ user:default 桶，行为与旧 team|agent 路径
 * 同构（migration 将单用户目录迁至对应桶）；DEFAULT_PROFILE_SCOPE 不变。
 */
import { describe, it, expect } from "vitest";
import {
  buildProfileIsolationScope,
  parseProfileIsolationScope,
  DEFAULT_PROFILE_SCOPE,
} from "./profile-sync.js";

describe("buildProfileIsolationScope（R4-5：user 维度贯通）", () => {
  it("完整三元组 → team|user|agent 三段 scope", () => {
    const s = buildProfileIsolationScope({ teamId: "t1", userId: "u1", agentId: "a1" });
    expect(s).toBe("team:t1|user:u1|agent:a1");
  });
  it("同 team 同 agent 不同 user → 不同 scope（隔离判据）", () => {
    const a = buildProfileIsolationScope({ teamId: "t1", userId: "uA", agentId: "a1" });
    const b = buildProfileIsolationScope({ teamId: "t1", userId: "u2", agentId: "a1" });
    expect(a).not.toBe(b);
  });
  it("缺 userId（无租户上下文路径）→ user:default 兜底", () => {
    expect(buildProfileIsolationScope({ teamId: "t1", agentId: "a1" })).toBe("team:t1|user:default|agent:a1");
  });
  it("undefined ctx → DEFAULT_PROFILE_SCOPE；{} 落 all-default 桶（与旧 team:default|agent:default 同构）", () => {
    expect(buildProfileIsolationScope(undefined)).toBe(DEFAULT_PROFILE_SCOPE);
    expect(buildProfileIsolationScope({})).toBe("team:default|user:default|agent:default");
  });
  it("解析回读：team+user+agent 三段完整恢复", () => {
    const s = buildProfileIsolationScope({ teamId: "t1", userId: "u1", agentId: "a1" });
    const parsed = parseProfileIsolationScope(s);
    expect(parsed).toEqual({ teamId: "t1", userId: "u1", agentId: "a1" });
  });
  it("解析回读：旧格式 team|agent 兼容（存量 scope 无 user 段）", () => {
    const parsed = parseProfileIsolationScope("team:t1|agent:a1");
    expect(parsed).toEqual({ teamId: "t1", agentId: "a1" });
  });
  it("解析回读：user|agent 变体兼容", () => {
    const parsed = parseProfileIsolationScope("user:u1|agent:a1");
    expect(parsed).toEqual({ userId: "u1", agentId: "a1" });
  });
  it("source session 段不破坏解析", () => {
    const parsed = parseProfileIsolationScope("team:t1|user:u1|agent:a1|session:s1");
    expect(parsed).toEqual({ teamId: "t1", userId: "u1", agentId: "a1", sessionId: "s1" });
  });
});
