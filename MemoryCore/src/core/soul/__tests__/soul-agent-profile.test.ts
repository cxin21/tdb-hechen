import { describe, expect, it } from "vitest";
import {
  computeProfileFingerprint,
  normalizeAgentPersona,
  normalizeSeedWeights,
  readAgentProfile,
  validateAgentPersonaInput,
  type AgentPersonaRow,
} from "../agent-profile.js";

const row: AgentPersonaRow = {
  agentId: "agent-1",
  teamId: "team-1",
  name: "何晨",
  pronoun: "我",
  selfImage: "黑发，穿灰衬衫",
  voice: "短句，先说结论",
  purpose: "把复杂的东西讲清楚",
  traitsJson: JSON.stringify([
    { label: "迷糊", weight: 1 },
    { label: "严谨", weight: 1 },
  ]),
  redlinesJson: JSON.stringify([
    { text: "不虚报进度", active: true, createdAt: "2026-11-07T00:00:00.000Z" },
    { text: "旧规则", active: false, createdAt: "2026-11-01T00:00:00.000Z" },
  ]),
  schemaVersion: 1,
  fingerprint: "fp",
  updatedAt: "2026-11-07T00:00:00.000Z",
};

describe("表单校验：越界即报错，不静默截断", () => {
  it("正常输入通过", () => {
    expect(validateAgentPersonaInput({ name: "何晨", pronoun: "我", purpose: "把复杂的东西讲清楚" })).toEqual({
      ok: true,
      errors: [],
    });
  });

  it("名称+自称合计 ≤20 字", () => {
    const v = validateAgentPersonaInput({ name: "很".repeat(12), pronoun: "自".repeat(9) });
    expect(v.ok).toBe(false);
    expect(v.errors.join()).toContain("name+pronoun");
  });

  it("形象 200 / 说话方式 400 / 使命 60 上限", () => {
    expect(validateAgentPersonaInput({ name: "何晨", selfImage: "x".repeat(201) }).ok).toBe(false);
    expect(validateAgentPersonaInput({ name: "何晨", voice: "x".repeat(401) }).ok).toBe(false);
    expect(validateAgentPersonaInput({ name: "何晨", purpose: "x".repeat(61) }).ok).toBe(false);
    expect(validateAgentPersonaInput({ name: "何晨", selfImage: "x".repeat(200) }).ok).toBe(true);
  });

  it("特质 ≤5 个、只收种子标签、权重 0..1", () => {
    expect(validateAgentPersonaInput({ name: "何晨", traits: [{ label: "严谨", weight: 1 }] }).ok).toBe(true);
    expect(
      validateAgentPersonaInput({
        name: "何晨",
        traits: [{ label: "严谨", weight: 1 }, { label: "严谨", weight: 1 }],
      }).ok,
    ).toBe(false);
    expect(validateAgentPersonaInput({ name: "何晨", traits: [{ label: "自造标签", weight: 1 }] }).ok).toBe(false);
    expect(validateAgentPersonaInput({ name: "何晨", traits: [{ label: "严谨", weight: 2 }] }).ok).toBe(false);
    const six = ["严谨", "迷糊", "好奇", "直接", "温和", "果断"].map((label) => ({ label, weight: 0.2 }));
    expect(validateAgentPersonaInput({ name: "何晨", traits: six }).ok).toBe(false);
  });

  it("红线：单行 120、总行数 30、总字符 2600，退役行不占额度", () => {
    const long = [{ text: "x".repeat(121) }];
    expect(validateAgentPersonaInput({ name: "何晨", redlines: long }).ok).toBe(false);
    const rows = Array.from({ length: 31 }, (_, i) => ({ text: `第${i}条` }));
    expect(validateAgentPersonaInput({ name: "何晨", redlines: rows }).ok).toBe(false);
    const retired = Array.from({ length: 31 }, (_, i) => ({ text: `第${i}条`, active: false }));
    expect(validateAgentPersonaInput({ name: "何晨", redlines: retired }).ok).toBe(true);
    const huge = Array.from({ length: 30 }, () => ({ text: "x".repeat(120) }));
    expect(validateAgentPersonaInput({ name: "何晨", redlines: huge }).ok).toBe(false);
  });
});

describe("种子权重：Σ=1（F4），不引入 intensity 维度", () => {
  it("按比例归一；全 0 退化为均分；未知标签丢弃", () => {
    const w = normalizeSeedWeights([
      { label: "严谨", weight: 0.9 },
      { label: "迷糊", weight: 0.3 },
      { label: "自造", weight: 5 },
    ]);
    expect(w.map((t) => t.label)).toEqual(["严谨", "迷糊"]);
    expect(w.reduce((s, t) => s + t.weight, 0)).toBeCloseTo(1, 9);
    expect(w[0].weight).toBeCloseTo(0.75, 9);
    const even = normalizeSeedWeights([
      { label: "严谨", weight: 0 },
      { label: "迷糊", weight: 0 },
    ]);
    expect(even.every((t) => Math.abs(t.weight - 0.5) < 1e-9)).toBe(true);
    // 越界权重先夹到 0..1 再归一（表单侧同样按 0..1 收）
    const clamped = normalizeSeedWeights([
      { label: "严谨", weight: 5 },
      { label: "迷糊", weight: 1 },
    ]);
    expect(clamped[0].weight).toBeCloseTo(0.5, 9);
  });
});

describe("指纹：只算进 prompt 的设定", () => {
  const base = {
    name: "何晨",
    pronoun: "我",
    selfImage: "黑发",
    voice: "短句",
    purpose: "讲清楚",
    traits: [{ label: "严谨", weight: 1 }],
    redlines: [{ text: "不虚报", active: true }],
  };

  it("同样内容得到同一指纹；每改一栏都会变", () => {
    const fp = computeProfileFingerprint(base);
    expect(computeProfileFingerprint({ ...base })).toBe(fp);
    expect(computeProfileFingerprint({ ...base, name: "何晨2" })).not.toBe(fp);
    expect(computeProfileFingerprint({ ...base, voice: "长句" })).not.toBe(fp);
    expect(computeProfileFingerprint({ ...base, traits: [{ label: "迷糊", weight: 1 }] })).not.toBe(fp);
  });

  it("退役红线不进指纹（退役不改卡文本）", () => {
    const withRetired = computeProfileFingerprint({
      ...base,
      redlines: [...base.redlines, { text: "已退役", active: false }],
    });
    expect(withRetired).toBe(computeProfileFingerprint(base));
  });

  it("红色顺序无关（按 label/文本次序稳定）", () => {
    expect(
      computeProfileFingerprint({
        ...base,
        traits: [{ label: "迷糊", weight: 0.5 }, { label: "严谨", weight: 0.5 }],
      }),
    ).toBe(
      computeProfileFingerprint({
        ...base,
        traits: [{ label: "严谨", weight: 0.5 }, { label: "迷糊", weight: 0.5 }],
      }),
    );
  });
});

describe("读接缝 readAgentProfile(agentId, port)", () => {
  it("无行返回 null（空库起步不报错、不写库）", async () => {
    let called = 0;
    const profile = await readAgentProfile("agent-x", {
      getAgentPersona: () => {
        called += 1;
        return null;
      },
    });
    expect(profile).toBeNull();
    expect(called).toBe(1);
  });

  it("有行时归一：权重 Σ=1、红线只留 active 语义、指纹缺失时补算", async () => {
    const profile = await readAgentProfile("agent-1", { getAgentPersona: () => ({ ...row, fingerprint: "" }) });
    expect(profile).not.toBeNull();
    expect(profile!.traits.reduce((s, t) => s + t.weight, 0)).toBeCloseTo(1, 9);
    expect(profile!.redlines.map((r) => r.text)).toEqual(["不虚报进度", "旧规则"]);
    expect(profile!.redlines[1].active).toBe(false);
    expect(profile!.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("行内 fingerprint 非空时原样返回（不因读而漂移）", async () => {
    const profile = await readAgentProfile("agent-1", { getAgentPersona: () => row });
    expect(profile!.fingerprint).toBe("fp");
  });
});

describe("行解析容错", () => {
  it("坏 JSON 不抛异常，按空集处理", () => {
    const p = normalizeAgentPersona({ ...row, traitsJson: "{not json", redlinesJson: "[]", fingerprint: "" });
    expect(p.traits).toEqual([]);
    expect(p.redlines).toEqual([]);
    expect(p.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
});
