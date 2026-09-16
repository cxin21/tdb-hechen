/**
 * v4#5（REG-REMAINING-004 #5）golden：提取尾窗续批 / 重启恢复的调度语义。
 *
 * 实锤缺陷背景（session-e，2026-09-16）：
 *  ① 重启吞掉 add 触发的提取调度——LocalStateBackend 的 count+timer 全在进程内，
 *     gateway 从不恢复 checkpoint 状态 → recoverPendingSessions 是修复面；
 *  ② hasMore 尾段续批靠 armL1IdleAfterDrain 挂定时器，但 timer 任务带
 *     triggeredBy=timer_scanner，executor 对 count===0 的 timer 任务去重跳过
 *     → 续批定时器曾复用 L1_idle 成员而被去重饿死。修复后用独立 L1_drain
 *     成员（executor 侧 isDrainTimer 豁免，游标治理保证收敛）。
 *
 * 本文件锁三个不变量：
 *  - L1_drain timer member 解析为 L1 任务（plain + scoped 两种形态）；
 *  - armL1IdleAfterDrain 挂 L1_drain（而非 L1_idle）成员；
 *  - recoverPendingSessions 逐会话挂 L1_drain 且遵守 SessionFilter / destroy /
 *    service-mode（__unset__）语义。
 */
import { describe, expect, it } from "vitest";

import { LocalStateBackend } from "../core/state/local-backend.js";
import {
  buildPipelineTimerMember,
  parsePipelineTimerMember,
} from "../core/state/timer-member.js";
import { StatefulPipelineManager } from "./stateful-pipeline-manager.js";

const loggerStub = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function newManager(instanceId = "default"): { mgr: StatefulPipelineManager; backend: LocalStateBackend } {
  const backend = new LocalStateBackend();
  const mgr = new StatefulPipelineManager(
    {
      everyNConversations: 5,
      enableWarmup: false,
      l1: { idleTimeoutSeconds: 600 },
      l2: {
        delayAfterL1Seconds: 90,
        minIntervalSeconds: 900,
        maxIntervalSeconds: 3600,
        sessionActiveWindowHours: 24,
      },
    },
    backend,
    instanceId,
    loggerStub,
  );
  return { mgr, backend };
}

describe("L1_drain timer member (v4#5 续批语义)", () => {
  it("parses to an L1 task in both plain and scoped forms", () => {
    const plain = buildPipelineTimerMember("session-abc", "L1_drain");
    expect(plain).toBe("session-abc:L1_drain");
    const parsedPlain = parsePipelineTimerMember(plain);
    expect(parsedPlain.taskType).toBe("L1");
    expect(parsedPlain.timerType).toBe("L1_drain");
    expect(parsedPlain.sessionId).toBe("session-abc");

    const scoped = buildPipelineTimerMember("session-abc", "L1_drain", {
      teamId: "team-x",
      agentId: "agent-y",
    });
    const parsedScoped = parsePipelineTimerMember(scoped);
    expect(parsedScoped.taskType).toBe("L1");
    expect(parsedScoped.timerType).toBe("L1_drain");
    expect(parsedScoped.sessionId).toBe("session-abc");
    expect(parsedScoped.teamId).toBe("team-x");
    expect(parsedScoped.agentId).toBe("agent-y");
  });

  it("is distinct from the L1_idle member key (both timers can coexist)", () => {
    const idle = buildPipelineTimerMember("session-abc", "L1_idle");
    const drain = buildPipelineTimerMember("session-abc", "L1_drain");
    expect(drain).not.toBe(idle);
    expect(drain.endsWith("L1_drain")).toBe(true);
  });
});

describe("armL1IdleAfterDrain (v4#5 尾窗续批)", () => {
  it("arms an L1_drain member (not L1_idle) that fires as an L1 task", async () => {
    const { mgr, backend } = newManager();
    await mgr.armL1IdleAfterDrain("session-tail", "default");

    const expired = await backend.getExpiredTimers("default", Date.now() + 700_000);
    const drain = expired.filter((e) => e.member === "session-tail:L1_drain");
    expect(drain).toHaveLength(1);

    // 到期入队路径（gateway onTimerExpired / TimerScanner）用 parse 派发任务类型
    const parsed = parsePipelineTimerMember(drain[0]!.member);
    expect(parsed.taskType).toBe("L1");
  });
});

describe("recoverPendingSessions (v4#5 重启恢复待提取队列)", () => {
  it("arms one L1_drain timer per checkpointed session key", async () => {
    const { mgr, backend } = newManager();
    const armed = await mgr.recoverPendingSessions(["session-a", "session-b"]);
    expect(armed).toBe(2);

    const expired = await backend.getExpiredTimers("default", Date.now() + 700_000);
    const members = expired.map((e) => e.member).sort();
    expect(members).toEqual(["session-a:L1_drain", "session-b:L1_drain"]);
  });

  it("honors the session filter (internal/temp sessions are skipped)", async () => {
    const { mgr, backend } = newManager();
    const armed = await mgr.recoverPendingSessions([
      "session-real",
      "temp:slug-generator",
      "profile:team:t|agent:a|session:memory-scene-extract-1",
    ]);
    expect(armed).toBe(1);

    const expired = await backend.getExpiredTimers("default", Date.now() + 700_000);
    expect(expired.map((e) => e.member)).toEqual(["session-real:L1_drain"]);
  });

  it("is a no-op after destroy()", async () => {
    const { mgr, backend } = newManager();
    await mgr.destroy();
    expect(await mgr.recoverPendingSessions(["session-a"])).toBe(0);
    const expired = await backend.getExpiredTimers("default", Date.now() + 700_000);
    expect(expired).toHaveLength(0);
  });

  it("is a no-op in service mode (instanceId=__unset__)", async () => {
    const { mgr, backend } = newManager("__unset__");
    expect(await mgr.recoverPendingSessions(["session-a"])).toBe(0);
    const expired = await backend.getExpiredTimers("__unset__", Date.now() + 700_000);
    expect(expired).toHaveLength(0);
  });
});
