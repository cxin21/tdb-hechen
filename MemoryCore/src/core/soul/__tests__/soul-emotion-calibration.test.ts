/**
 * 情绪识别校准（T3）：8 个生产主类的受控样本 + 最小对立边界样本。
 *
 * 这不是人工标注语料，而是「判据回归矩阵」：受控集每类 30 条（对象 × 措辞），
 * 边界集每类 30 条（只改一个决定性线索，仍应判回本类）。它证明的是
 * 「同一套确定性判据在已知构造下不漂移」，不能替代真实用户标注；
 * 真实覆盖率仍以生产 soul_emotions 的零实例清单为准。
 */
import { describe, expect, it } from "vitest";
import { appraiseEmotion } from "../emotion.js";
import { episodeAppraisal } from "../episode.js";

type Kind = "praise" | "complaint" | "pressure" | "resignation" | "decision" | "correction" | "divergence" | "value_conflict";

interface Sample {
  expected: string;
  kind: Kind;
  userStance: string;
  agentStance: string;
  outcome: string;
  intensity: number;
  publicSession?: boolean;
}

const OBJECTS = ["登录按钮", "排序逻辑", "权限校验", "导入流程", "状态同步", "重试策略"];
const LABELS = ["不安", "恼火", "愧疚", "笃定", "害羞", "开心", "平静", "委屈"];

function labelOf(s: Sample): string {
  const appraisal = episodeAppraisal(
    { kind: s.kind, userStance: s.userStance, agentStance: s.agentStance, outcome: s.outcome, intensity: s.intensity },
    { publicSession: s.publicSession === true },
  );
  return appraiseEmotion({ at: "2026-11-06T00:00:00.000Z", object: "校准样本", appraisal }).label;
}

const ADMITTED = [
  "我漏了，已经补上了",
  "是我错了，已经改了",
  "我做得不对，我重做",
  "我逐项量过，已经对齐",
  "是我没做到，我收口了",
];

function controlled(): Sample[] {
  const out: Sample[] = [];
  for (const object of OBJECTS) {
    for (const agentStance of ADMITTED) {
      out.push({ expected: "愧疚", kind: "complaint", userStance: `这处${object}不对，你改坏了`, agentStance, outcome: "", intensity: 0.7 });
      out.push({
        expected: "害羞",
        kind: "complaint",
        userStance: `当着大家，这处${object}不对，你改坏了`,
        agentStance,
        outcome: "",
        intensity: 0.7,
      });
    }
  }
  const refuted = [
    "不是我造成的，上游缓存了旧数据",
    "不是我的问题，日志里没这条",
    "你弄错了，我查了日志",
    "不是我造成，我实测复现不出来",
    "你的问题，截图里返回正常",
  ];
  const blame = ["这个", "这处", "这块", "这版", "这个点"];
  for (const object of OBJECTS) {
    for (const agentStance of refuted) {
      out.push({ expected: "委屈", kind: "complaint", userStance: `这个${object}是不是你改坏的`, agentStance, outcome: "", intensity: 0.6 });
    }
    for (const agentStance of ["我先看一下", "我看看再说", "我查一下", "等一下", "我确认一下"]) {
      out.push({ expected: "恼火", kind: "complaint", userStance: `你搞错了吧，${object}又点不动`, agentStance, outcome: "", intensity: 0.6 });
    }
    out.push({ expected: "不安", kind: "divergence", userStance: `这个${object}再想想`, agentStance: "", outcome: "", intensity: 0.4 });
    out.push({ expected: "不安", kind: "divergence", userStance: `这里${object}再看看`, agentStance: "", outcome: "", intensity: 0.4 });
    out.push({ expected: "不安", kind: "divergence", userStance: `这个${object}再核对一下`, agentStance: "", outcome: "", intensity: 0.4 });
    out.push({ expected: "不安", kind: "divergence", userStance: `这版${object}再评估`, agentStance: "", outcome: "", intensity: 0.4 });
    out.push({ expected: "不安", kind: "divergence", userStance: `这个点${object}再确认`, agentStance: "", outcome: "", intensity: 0.4 });
    for (const userStance of [
      `就按${object}这个方案做`,
      `按方案推进${object}`,
      `必须把${object}落地`,
      `优先处理${object}`,
      `开始做${object}`,
    ]) {
      out.push({ expected: "笃定", kind: "decision", userStance, agentStance: "好，我开始改", outcome: "按方案改", intensity: 0.7 });
    }
    for (const userStance of [
      `这次${object}改得好，数对上了，就这么办`,
      `${object}这个结果很好`,
      `${object}这次对了`,
      `${object}处理得漂亮`,
      `${object}做得不错`,
    ]) {
      out.push({ expected: "开心", kind: "praise", userStance, agentStance: "好", outcome: "", intensity: 0.7 });
    }
    for (const userStance of [
      `收到，${object}放着吧`,
      `知道了，${object}不急`,
      `行，${object}这样`,
      `好，${object}可以`,
      `嗯，${object}知道了`,
    ]) {
      out.push({ expected: "平静", kind: "decision", userStance, agentStance: "好", outcome: "", intensity: 0.3 });
    }
  }
  // 上面每类 30 条（6 对象 × 5 措辞）；委屈/恼火/不安/笃定/开心/平静各 30。
  return out;
}

function boundary(): Sample[] {
  const out: Sample[] = [];
  for (const object of OBJECTS) {
    // 愧疚↔恼火/委屈：他先怀疑我，但我认账——归因看我的回复，不看他的火气。
    for (const userStance of [
      `你搞错了吧，这处${object}不对`,
      `是不是你改坏的，${object}又错了`,
      `${object}怎么又不对`,
      `你确认一下，${object}这处不对`,
      `这处${object}不对，你别糊弄`,
    ]) {
      out.push({ expected: "愧疚", kind: "complaint", userStance, agentStance: "我漏了，已经补上了", outcome: "", intensity: 0.7 });
    }
    // 害羞↔愧疚：同样当众，但我不认账——当众被看见 + 违规就够害羞。
    for (const publicWord of ["当着大家", "当众", "会议上", "当着所有人", "大家面前"]) {
      out.push({
        expected: "害羞",
        kind: "correction",
        userStance: `${publicWord}，这处${object}不对`,
        agentStance: "我先看一下",
        outcome: "",
        intensity: 0.7,
      });
    }
    // 委屈↔恼火：只差一句「不是我造成的」。
    for (const agentStance of ["不是我造成的", "不是我的问题", "你弄错了吧", "不是我造成", "你的问题"]) {
      out.push({ expected: "委屈", kind: "complaint", userStance: `这个${object}是不是你改坏的`, agentStance, outcome: "", intensity: 0.6 });
    }
    // 恼火↔委屈：同样被追责，但我不举证、也不认账。
    for (const userStance of [
      `你搞错了吧，${object}又点不动`,
      `${object}怎么又坏了`,
      `这处${object}不对，你搞什么`,
      `${object}还是错的，你到底看没看`,
      `又是我这边的问题？${object}根本不通`,
    ]) {
      out.push({ expected: "恼火", kind: "complaint", userStance, agentStance: "我看看", outcome: "", intensity: 0.6 });
    }
    // 不安↔着急：目标相关度卡在 0.55 门槛下。
    for (const intensity of [0.46, 0.48, 0.5, 0.52, 0.54]) {
      out.push({ expected: "不安", kind: "divergence", userStance: `这个${object}再想想`, agentStance: "", outcome: "", intensity });
    }
    // 笃定↔平静：只差一个方向词。
    for (const userStance of [`就按${object}来`, `按方案做${object}`, `必须让${object}落地`, `优先${object}`, `开始做${object}`]) {
      out.push({ expected: "笃定", kind: "decision", userStance, agentStance: "好", outcome: "", intensity: 0.7 });
    }
    // 开心↔感激：肯定但不含「辛苦/谢谢」这类对方代价词。
    for (const userStance of [`这次${object}改得好，数对上了`, `${object}这个结果很好`, `${object}这次对了`, `${object}处理得漂亮`, `${object}做得不错`]) {
      out.push({ expected: "开心", kind: "praise", userStance, agentStance: "好", outcome: "", intensity: 0.7 });
    }
    // 平静↔笃定：有回应、但目标相关度仍低于 0.55。
    for (const intensity of [0.46, 0.48, 0.5, 0.52, 0.54]) {
      out.push({ expected: "平静", kind: "decision", userStance: `收到，${object}放着吧`, agentStance: "好", outcome: "", intensity });
    }
  }
  return out;
}

function report(samples: Sample[], title: string): { accuracy: number; recalls: Record<string, number> } {
  const matrix = new Map<string, Map<string, number>>();
  for (const label of LABELS) matrix.set(label, new Map(LABELS.map((x) => [x, 0])));
  for (const s of samples) {
    const got = labelOf(s);
    const row = matrix.get(s.expected);
    row?.set(got, (row.get(got) ?? 0) + 1);
  }
  const recalls: Record<string, number> = {};
  let correct = 0;
  const mismatches: string[] = [];
  for (const s of samples) {
    const got = labelOf(s);
    if (got !== s.expected && mismatches.length < 20) mismatches.push(`${s.expected}->${got}: ${s.userStance} / ${s.agentStance}`);
  }
  for (const label of LABELS) {
    const row = matrix.get(label)!;
    const total = samples.filter((s) => s.expected === label).length;
    const hit = row.get(label) ?? 0;
    correct += hit;
    recalls[label] = total === 0 ? 0 : hit / total;
  }
  const accuracy = samples.length === 0 ? 0 : correct / samples.length;
  const head = ["expected\\got", ...LABELS].join("\t");
  const lines = [head];
  for (const label of LABELS) {
    const row = matrix.get(label)!;
    lines.push([label, ...LABELS.map((x) => String(row.get(x) ?? 0))].join("\t"));
  }
  // eslint-disable-next-line no-console
  console.log(`\n[${title}] accuracy=${(accuracy * 100).toFixed(1)}% n=${samples.length}\n${lines.join("\n")}${mismatches.length > 0 ? `\nmismatches:\n${mismatches.join("\n")}` : ""}`);
  return { accuracy, recalls };
}

describe("情绪识别校准矩阵（T3，合成受控样本，不代表人工标注）", () => {
  it("8 主类受控样本各 30 条：macro recall ≥ 0.75", () => {
    const samples = controlled();
    const { accuracy, recalls } = report(samples, "controlled");
    expect(samples).toHaveLength(240);
    for (const label of LABELS) expect(recalls[label], `${label} recall`).toBeGreaterThanOrEqual(0.75);
    expect(accuracy).toBeGreaterThanOrEqual(0.9);
  });

  it("8 主类最小对立边界各 30 条：macro recall ≥ 0.75，且不整体塌到邻类", () => {
    const samples = boundary();
    const { accuracy, recalls } = report(samples, "boundary");
    expect(samples).toHaveLength(240);
    for (const label of LABELS) expect(recalls[label], `${label} recall`).toBeGreaterThanOrEqual(0.75);
    expect(accuracy).toBeGreaterThanOrEqual(0.9);
  });
});
