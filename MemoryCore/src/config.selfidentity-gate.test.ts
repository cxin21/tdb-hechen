import { describe, it, expect } from "vitest";
import { parseConfig } from "./config.js";

/**
 * #91 返工补充（2026-10-24）：lifecycle.reflection.selfIdentityGate 配置接线。
 * 根因：parse 白名单（src/config.ts reflection 段）只拷贝 enabled/rRef/soulProposals/
 * promiseProposals——yaml 里的 selfIdentityGate 被静默剥离，runReflection cfg.selfIdentityGate
 * 恒 undefined → recOn 恒 false → #91 机制（echo 路由/计票/init/sweep）生产全旁路。
 * FLOW-E 同款「不接线即死配置」第四次重演（anchorDiscovery/selfIdentity/characterTension 先例）。
 * 本组用例钉住：显式写的键必须透传；不写=不带键=缺省行为逐位。
 */
interface SigProbe {
  lifecycle?: {
    reflection?: {
      selfIdentityGate?: {
        enabled?: boolean;
        threshold?: number;
        suppression?: { enabled?: boolean; maxPending?: number };
        recurrence?: { enabled?: boolean; votes?: number; ttlHours?: number; spanHours?: number };
        rateLimit?: { enabled?: boolean; maxNew?: number; windowHours?: number };
        autoAdopt?: { enabled?: boolean; votes?: number; spanHours?: number; contradictionThreshold?: number; dupThreshold?: number };
      };
    };
  };
}

describe("lifecycle.reflection.selfIdentityGate（#81/#91 配置接线）", () => {
  it("缺省：不带键（undefined=逐位现状——sim-gate/抑制缺省行为不变）", () => {
    const c = parseConfig({}) as unknown as SigProbe;
    expect(c.lifecycle?.reflection?.selfIdentityGate).toBeUndefined();
  });

  it("#91：yaml 显式 recurrence（enabled/votes/ttlHours/spanHours）逐键透传", () => {
    const c = parseConfig({
      lifecycle: {
        reflection: {
          selfIdentityGate: {
            enabled: true,
            recurrence: { enabled: true, votes: 3, ttlHours: 72, spanHours: 72 },
          },
        },
      },
    }) as unknown as SigProbe;
    const sig = c.lifecycle?.reflection?.selfIdentityGate;
    expect(sig?.enabled).toBe(true);
    expect(sig?.recurrence?.enabled).toBe(true);
    expect(sig?.recurrence?.votes).toBe(3);
    expect(sig?.recurrence?.ttlHours).toBe(72);
    expect(sig?.recurrence?.spanHours).toBe(72);
  });

  it("部分键：只写 recurrence.enabled+ttlHours 时其余键不带（spanHours 缺省跟随 ttlHours 由消费侧兜底）", () => {
    const c = parseConfig({
      lifecycle: { reflection: { selfIdentityGate: { recurrence: { enabled: true, ttlHours: 72 } } } },
    }) as unknown as SigProbe;
    const sig = c.lifecycle?.reflection?.selfIdentityGate;
    expect(sig?.recurrence?.enabled).toBe(true);
    expect(sig?.recurrence?.ttlHours).toBe(72);
    expect(sig?.recurrence).not.toHaveProperty("votes");
    expect(sig?.recurrence).not.toHaveProperty("spanHours");
    expect(sig).not.toHaveProperty("enabled"); // 顶层 enabled 未写不带
  });

  it("#91 K 阀：rateLimit 显式逐键透传；不写=不带键（缺省 off 逐位）", () => {
    const on = parseConfig({
      lifecycle: { reflection: { selfIdentityGate: { rateLimit: { enabled: true, maxNew: 12, windowHours: 24 } } } },
    }) as unknown as SigProbe;
    const rl = on.lifecycle?.reflection?.selfIdentityGate?.rateLimit;
    expect(rl?.enabled).toBe(true);
    expect(rl?.maxNew).toBe(12);
    expect(rl?.windowHours).toBe(24);
    const off = parseConfig({
      lifecycle: { reflection: { selfIdentityGate: { recurrence: { enabled: true } } } },
    }) as unknown as SigProbe;
    expect(off.lifecycle?.reflection?.selfIdentityGate).not.toHaveProperty("rateLimit");
  });

  it("降级：非对象 selfIdentityGate 不带键（宽容解析不抛）", () => {
    const c = parseConfig({
      lifecycle: { reflection: { selfIdentityGate: "garbage" } },
    }) as unknown as SigProbe;
    expect(c.lifecycle?.reflection?.selfIdentityGate).toBeUndefined();
  });

  it("#92 stage 2：autoAdopt 显式逐键透传（enabled/votes/spanHours/contradictionThreshold/dupThreshold）", () => {
    const c = parseConfig({
      lifecycle: { reflection: { selfIdentityGate: { autoAdopt: { enabled: true, votes: 4, spanHours: 72, contradictionThreshold: 0.6, dupThreshold: 0.75 } } } },
    }) as unknown as SigProbe;
    const aa = c.lifecycle?.reflection?.selfIdentityGate?.autoAdopt;
    expect(aa?.enabled).toBe(true);
    expect(aa?.votes).toBe(4);
    expect(aa?.spanHours).toBe(72);
    expect(aa?.contradictionThreshold).toBe(0.6);
    expect(aa?.dupThreshold).toBe(0.75);
  });

  it("#92 stage 2：部分键只写 enabled 其余不带；不写 autoAdopt=不带键（缺省 off 逐位）", () => {
    const on = parseConfig({
      lifecycle: { reflection: { selfIdentityGate: { autoAdopt: { enabled: true } } } },
    }) as unknown as SigProbe;
    const aa = on.lifecycle?.reflection?.selfIdentityGate?.autoAdopt;
    expect(aa?.enabled).toBe(true);
    expect(aa).not.toHaveProperty("votes");
    expect(aa).not.toHaveProperty("spanHours");
    const off = parseConfig({
      lifecycle: { reflection: { selfIdentityGate: { recurrence: { enabled: true } } } },
    }) as unknown as SigProbe;
    expect(off.lifecycle?.reflection?.selfIdentityGate).not.toHaveProperty("autoAdopt");
  });
});
