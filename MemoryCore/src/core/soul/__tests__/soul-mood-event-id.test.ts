/**
 * 心境账本行的 id 口径（2026-11-10 生产复查）。
 *
 * 背景：soul_mood_events.id 是全局主键，旧写法 `mood-<now>-<kind>` 不带租户。
 * 同一毫秒里两个租户各推一条 appraisal，第二个 INSERT OR IGNORE 一行不写——
 * 与叙事 chapter_id 同一个坑（那里生产实测四个租户只落一章）。这条用例钉住前缀。
 */
import { describe, expect, it } from "vitest";
import { soulMoodEventId } from "../worker.js";
import { narrativeTenantTag, tenantTagOf } from "../narrative.js";

const NOW = "2026-11-10T13:52:10.182Z";
const A = { teamId: "team-2k12lgb650", userId: "usr-2m7b1144d9", agentId: "agt-h6dp2dvr4a" };
const B = { teamId: "team-2k12lgb650", userId: "usr-2m7b1144d9", agentId: "agt-bbr29z58s2" };

describe("心境账本行 id", () => {
  it("同一毫秒的两个租户不撞 id", () => {
    const a = soulMoodEventId(NOW, "appraisal", A);
    const b = soulMoodEventId(NOW, "appraisal", B);
    expect(a).not.toBe(b);
    expect(a).toContain(tenantTagOf(A));
  });

  it("同租户同毫秒同 kind 仍是同一个 id：重试幂等，不重复记账", () => {
    expect(soulMoodEventId(NOW, "appraisal", A)).toBe(soulMoodEventId(NOW, "appraisal", A));
    expect(soulMoodEventId(NOW, "appraisal", A)).not.toBe(soulMoodEventId(NOW, "decay", A));
  });

  it("与叙事章前缀是同一把尺", () => {
    expect(tenantTagOf(A)).toBe(narrativeTenantTag(A));
    expect(tenantTagOf(A)).toHaveLength(8);
  });
});
