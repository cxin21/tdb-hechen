import { describe, expect, it } from "vitest";
import { classifyInbound } from "../intent-classifier.js";

// ── 真实形态 fixtures（#83 票合同：取自本会话实录 + L0/journal 全量审计实证）──

const Q1 = "为什么现在记忆召回日志全是scaffold-skip，全是空白的，用户消息、灵魂注入、召回的记忆全是空白";
const Q2 = "请用第一性原理分析以下主题，再结合真实数据和代码做分析，是否根本原因，到底怎么处理";
const Q3 = "如果仅允许改tdb呢，你再分析一下";
const Q4 = "拍板";
const Q5 = "目前的L0中的所有用户信息都能经这个算法完成数据清洗么，你好好测试一下，分析分析我们捕获的时候到底要什么样的信息";
const Q6 = "你先用已有的真实数据做最小修改验证，先验证可行性和最优算法";
const Q7 = "还有L0记忆捕获，对话内容的捕获也有问题，你也分析一下吧，然后针对这两个场景给我一个完整的优化方案，必须包括：1、真实数据现状；2、现在的逻辑；3、预计优化后真实数据样例；4、优化方案";
const Q8 = "按你的说法，根本原因其实在源头提取器，对么";
const Q9 = "直接根治，应该怎么改";

const APPROVAL = 'The approval policy changed from "ask" to "never" (changed by the user).';
const TIMESAMPLE = [
  "Time sampled while preparing turn 1, step 6: 2026-10-21T14:37:35+08:00[Asia/Shanghai]",
  "Browser time zone for this request: Asia/Shanghai. Interpret otherwise-unqualified dates and times in this zone.",
  "Elapsed since the preceding step context: 10m 16s.",
].join("\n");
const SYSREM = "<system-reminder>Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\nCurrent working directory: D:\\TDB\\td-agemem.\nCurrent DSH file policy: danger-full-access.</system-reminder>";
const FEELING = "<current_feeling>\n当前问题触及的核心价值：正确。\n本轮方向：围绕【正确】推进\n</current_feeling>";
const WIKI = "<tdai_recalled_wiki>\n以下是当前轮用户问题自动召回的团队 wiki 索引（JIT 精简模式…）\n1. [wiki:scm-standards] [concept] score=1.00 — 开发禁令\n</tdai_recalled_wiki>";
const COMPRESSED = "[Compressed conversation section] — 召回日志 scaffold-skip 诊断·上半场\nTASK AS OF THIS BLOCK: 用户问（m00002）「为什么现在记忆召回日志全是scaffold-skip」\nOpen objectives: 回答 m00002 根因诊断（进行中）";
const RUNTIME_CTX = "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\nCurrent working directory: D:\\TDB\\td-agemem.";

const u = (content: string) => ({ role: "user", content });
const a = (content: string) => ({ role: "assistant", content });

describe("classifyInbound — 13 步真实回放（#83 合同 Part A：9 真实 turn step-1 + 4 mid-turn）", () => {
  it("T1S1：含真实提问 + 5 条脚手架（本会话 turn-1 实录形态）", () => {
    const msgs = [u(Q1), u(APPROVAL), u(SYSREM), u(TIMESAMPLE), u(FEELING), u(WIKI)];
    const got = classifyInbound(msgs);
    expect(got.turnIntent?.text).toBe(Q1);
    expect(got.classified).toHaveLength(6);
    expect(got.classified.filter((c) => c.classification === "real")).toHaveLength(1);
    expect(got.classified.filter((c) => c.classification === "scaffold")).toHaveLength(5);
  });

  it("T1S2（mid-turn 无新 real）：历史里的 Q1 仍为 turnIntent（召回不丢主链路）", () => {
    const msgs = [u(Q1), u(APPROVAL), u(SYSREM), u(TIMESAMPLE), a("（诊断中）"), u(TIMESAMPLE.replace("step 6", "step 7"))];
    expect(classifyInbound(msgs).turnIntent?.text).toBe(Q1);
  });

  it("T2S1：压缩块在前 + 真实提问在后", () => {
    const msgs = [u(COMPRESSED), u(Q2), u(SYSREM), u(TIMESAMPLE), u(FEELING)];
    expect(classifyInbound(msgs).turnIntent?.text).toBe(Q2);
  });

  it("T2S2（mid-turn）：历史压缩块 + Q2 仍命中", () => {
    const msgs = [u(COMPRESSED), u(Q2), u(SYSREM), u(TIMESAMPLE), a("（分析中）")];
    expect(classifyInbound(msgs).turnIntent?.text).toBe(Q2);
  });

  it("T2S3（mid-turn）：裸 runtime-context 快照（无 XML wrapper）也判 scaffold", () => {
    const msgs = [u(COMPRESSED), u(Q2), u(SYSREM), u(TIMESAMPLE), a("x"), u(RUNTIME_CTX)];
    expect(classifyInbound(msgs).turnIntent?.text).toBe(Q2);
  });

  it("T3S1", () => {
    expect(classifyInbound([u(COMPRESSED), u(Q3), u(TIMESAMPLE)]).turnIntent?.text).toBe(Q3);
  });
  it("T4S1：两字真拍板不因长度被丢", () => {
    expect(classifyInbound([u(COMPRESSED), u(Q4), u(TIMESAMPLE), u(FEELING)]).turnIntent?.text).toBe(Q4);
  });
  it("T5S1", () => {
    expect(classifyInbound([u(COMPRESSED), u(Q5), u(TIMESAMPLE)]).turnIntent?.text).toBe(Q5);
  });
  it("T5S2（mid-turn）", () => {
    expect(classifyInbound([u(COMPRESSED), u(Q5), a("审计结果…"), u(TIMESAMPLE)]).turnIntent?.text).toBe(Q5);
  });
  it("T6S1", () => {
    expect(classifyInbound([u(COMPRESSED), u(Q6), u(TIMESAMPLE)]).turnIntent?.text).toBe(Q6);
  });
  it("T7S1", () => {
    expect(classifyInbound([u(COMPRESSED), u(Q7), u(TIMESAMPLE)]).turnIntent?.text).toBe(Q7);
  });
  it("T8S1", () => {
    expect(classifyInbound([u(COMPRESSED), u(Q8), u(TIMESAMPLE)]).turnIntent?.text).toBe(Q8);
  });
  it("T9S1", () => {
    expect(classifyInbound([u(COMPRESSED), u(Q9), u(TIMESAMPLE)]).turnIntent?.text).toBe(Q9);
  });
});

describe("classifyInbound — 6 边界（L0 全量审计实证，宁可漏过不可错杀）", () => {
  it("裸 ⚠️ 开头的真提问不误杀（头规则只锚定「⚠️ Context limit」完整短语）", () => {
    const got = classifyInbound([u("⚠️ 出现了这个报错是什么意思")]);
    expect(got.turnIntent?.text).toBe("⚠️ 出现了这个报错是什么意思");
  });

  it("xml-paste：未知根标签不整条判 scaffold（变体 P：协议标签枚举）", () => {
    const got = classifyInbound([u("<root><a>1</a></root>\n这个报错怎么处理？")]);
    expect(got.turnIntent?.text).toBe("这个报错怎么处理？");
  });

  it("jsx-paste：未知标签 + 粘贴代码 + 真提问 → real", () => {
    const got = classifyInbound([u('<div className="x">内容</div>\n帮我改成 flex 布局')]);
    expect(got.turnIntent?.text).toBe("帮我改成 flex 布局");
  });

  it("引用效率提醒文：nudge 短语不在行首 → 不尾杀，全文保留", () => {
    const t = "系统提示说 This is an efficiency nudge to compress early，这是什么意思？";
    const got = classifyInbound([u(t)]);
    expect(got.turnIntent?.text).toBe(t);
  });

  it("真问题 + 尾随 system-reminder：剥块留真（L0 无 10 字门）", () => {
    const got = classifyInbound([u("为什么召回是空的？\n<system-reminder>workspace rules</system-reminder>")]);
    expect(got.turnIntent?.text).toBe("为什么召回是空的？");
  });

  it("纯英文提问：大写开头无 CJK → unknown（保留观测，不作 intent）", () => {
    const got = classifyInbound([u("Fix the login bug")]);
    expect(got.turnIntent).toBeNull();
    expect(got.classified[0].classification).toBe("unknown");
  });
});

describe("classifyInbound — 3 新边界（根治架构验证 fixture 教训）", () => {
  it("全角【开头 → real（rid 1100 实录形态）", () => {
    const t = "【TDB 记忆系统排查结论 2026-10-14】tdb 记忆只有 L0 无 L1/L2/L3 的根因排查：13:19 重启后计数器疑似失效。";
    const got = classifyInbound([u(t)]);
    expect(got.turnIntent?.text).toBe(t);
    expect(got.classified[0].classification).toBe("real");
  });

  it("小写开头的助手摘要碎片 → echo（无长度门槛；rid 178 实录形态）", () => {
    const got = classifyInbound([u("rchTiming, conclusionCount, experienceCount, sessionReused")]);
    expect(got.classified[0].classification).toBe("echo");
    expect(got.turnIntent).toBeNull();
  });

  it("英文指令文大写开头 → unknown（保留观测，不作 intent）", () => {
    const got = classifyInbound([u("Summarize the changes you made to the auth module")]);
    expect(got.classified[0].classification).toBe("unknown");
    expect(got.turnIntent).toBeNull();
  });
});

describe("classifyInbound — 生产实证回归（2026-10-21 L0：acp 标签与键入同条共存 = DSH 主形态）", () => {
  const TAGGED_REAL = '<acp tokens="22" type="text">m00458</acp> 不要影子期，直接进行本机生产测试，你重启生效吧';
  const TAGGED_TIME = '<acp tokens="64" type="text">m00478</acp>\nTime sampled while preparing turn 12, step 6: 2026-10-21T18:44:52+08:00[Asia/Shanghai]';
  const TAGGED_NOTIFY = '<acp tokens="57" type="text">m00485</acp>\nBackground subagent fbe90b92-29ae-4d7e-b054-694dad5e2a5b failed before it finished.';

  it("标签 + 真实键入共存 → real（残差去标签判意；raw 保留原文供 L0 宁漏勿杀）", () => {
    const got = classifyInbound([u(TAGGED_REAL)]);
    expect(got.turnIntent?.text).toBe("不要影子期，直接进行本机生产测试，你重启生效吧");
    expect(got.classified[0].classification).toBe("real");
    expect(got.classified[0].raw).toBe(TAGGED_REAL);
  });

  it("标签 + 时间采样共存 → scaffold（残差走头规则，不因共存修复放宽）", () => {
    const got = classifyInbound([u(TAGGED_TIME)]);
    expect(got.classified[0].classification).toBe("scaffold");
    expect(got.turnIntent).toBeNull();
  });

  it("标签 + 后台任务通知共存 → scaffold（通知头规则，残差为系统通知）", () => {
    const got = classifyInbound([u(TAGGED_NOTIFY)]);
    expect(got.classified[0].classification).toBe("scaffold");
    expect(got.turnIntent).toBeNull();
  });

  it("后台子代理失败通知（含 CJK 引文全文）→ scaffold（通知非意图；19:01 生产实锚 qLen=157 污染行）", () => {
    const t = '<acp tokens="57" type="text">m00485</acp> Background subagent fbe90b92-29ae-4d7e-b054-694dad5e2a5b failed before it finished.Its closing message:\n\n红线确认——只读审查合规持续。继续读 chunk 实现、TdaiMessage 类型与 bind 全序。';
    const got = classifyInbound([u(t)]);
    expect(got.classified[0].classification).toBe("scaffold");
    expect(got.turnIntent).toBeNull();
  });

  it("后台任务完成通知（小写）→ scaffold（结构信号优先于内容占比）", () => {
    const t = "background job bash-48d94d948d814e7b (bash: cd /d/TDB/td-agemem/MemoryProxy && pnpm vitest run 2>&1 | tail -15) finished [status: completed, exit code: 0]. Read its output with job_output.";
    const got = classifyInbound([u(t)]);
    expect(got.classified[0].classification).toBe("scaffold");
    expect(got.turnIntent).toBeNull();
  });

  it("整条协议块无残差仍 scaffold（<current_feeling> CJK 巨块不得经内容级剥噪泄漏）", () => {
    const got = classifyInbound([u(FEELING)]);
    expect(got.classified[0].classification).toBe("scaffold");
    expect(got.turnIntent).toBeNull();
  });
});

describe("classifyInbound — 语义细节", () => {
  it("同轮重复内容 → 第二条 dup，turnIntent 取首条 real", () => {
    const got = classifyInbound([u(Q4), u(Q4)]);
    expect(got.classified[0].classification).toBe("real");
    expect(got.classified[1].classification).toBe("dup");
    expect(got.turnIntent?.text).toBe(Q4);
  });

  it("小写开头但 CJK 占比≥0.10 → real（占比门保护中英混输；fixture 实测 0.143）", () => {
    const got = classifyInbound([u("how do I fix 这个 bug")]);
    expect(got.turnIntent?.text).toBe("how do I fix 这个 bug");
  });

  it("小写开头但 CJK 占比<0.10（零星 CJK 碎片）→ echo（golden replay 实测碎片桶 0.003–0.036）", () => {
    const got = classifyInbound([u("loads+succeeds; allowAutoDownload: false; 摄像头 pipeline repaired")]);
    expect(got.classified[0].classification).toBe("echo");
    expect(got.turnIntent).toBeNull();
  });

  it("scaffold 条目的 text 恒为空串（契约对齐 core RED 用例 6）", () => {
    const got = classifyInbound([u(Q1), u(SYSREM), u(TIMESAMPLE)]);
    const sc = got.classified.find((c) => c.classification === "scaffold");
    expect(sc?.text).toBe("");
  });

  it("非 user 角色消息不参与分类，turnIntent 只看 user 消息", () => {
    const got = classifyInbound([u(Q1), a("假设答案是 X"), u(TIMESAMPLE)]);
    expect(got.turnIntent?.text).toBe(Q1);
    expect(got.classified).toHaveLength(2);
  });

  it("空消息/纯空白 → scaffold", () => {
    const got = classifyInbound([u(""), u("   ")]);
    expect(got.classified.every((c) => c.classification === "scaffold")).toBe(true);
    expect(got.turnIntent).toBeNull();
  });
});

describe("classifyInbound - 审查批次修复（P1 畸形闭合 / P3 goal_round / 规则⑥ 小写问句 / 规则⑦ 尾行 CJK / Me4 覆盖）", () => {
  it("P1：已知标签 + 畸形闭合（<//acp>）→ 剥块残差 real（边界用例 malformedClose 实锚）", () => {
    const got = classifyInbound([u('<acp tokens="1">m1<//acp>\n现在几点？')]);
    expect(got.classified[0].classification).toBe("real");
    expect(got.classified[0].text).toBe("现在几点？");
  });

  it("P1：已知标签真无闭合 → 仍整条 scaffold（防 CJK 泄漏语义不放宽）", () => {
    const got = classifyInbound([u('<acp tokens="1">m1 现在几点？')]);
    expect(got.classified[0].classification).toBe("scaffold");
  });

  it("P3：<goal_round> 块单独出现 → scaffold（不再 artifact；journal 实锚形态）", () => {
    const got = classifyInbound([u("<goal_round> Objective: ship it</goal_round>")]);
    expect(got.classified[0].classification).toBe("scaffold");
  });

  it("P3：<goal_round> 块 + 尾随真实提问 → real（共存不整条丢）", () => {
    const got = classifyInbound([u("<goal_round> Objective: ship it</goal_round>\n重启后验证生效了吗？")]);
    expect(got.classified[0].classification).toBe("real");
  });

  it("规则⑥：小写英文真实问句（句末问号）→ real（journal 实锚误杀形态）", () => {
    const q = "do you remember what we discussed about the memory pipeline?";
    const got = classifyInbound([u(q)]);
    expect(got.classified[0].classification).toBe("real");
    expect(got.turnIntent?.text).toBe(q);
  });

  it("规则⑥负例：小写碎片句中问号但非句末 → 保持 echo", () => {
    const got = classifyInbound([u("loads+succeeds; ok? no, the gate held")]);
    expect(got.classified[0].classification).toBe("echo");
  });

  it("规则⑦：长英文日志 + 短中文提问尾行 → real（M3 标定盲区实锚）", () => {
    const log = Array.from({ length: 12 }, (_, i) => "ERR 2026-10-22T00:11:0" + i + "Z svc worker pool drained; retry scheduled").join("\n");
    const got = classifyInbound([u(log + "\n这个问题怎么修？")]);
    expect(got.classified[0].classification).toBe("real");
  });

  it("规则⑦负例：纯英文日志碎片（无 CJK）→ 不判 real", () => {
    const log = Array.from({ length: 12 }, (_, i) => "ERR 2026-10-22T00:11:0" + i + "Z svc worker pool drained; retry scheduled").join("\n");
    const got = classifyInbound([u(log)]);
    expect(["echo", "unknown"]).toContain(got.classified[0].classification);
    expect(got.turnIntent).toBeNull();
  });

  it("Me4 覆盖：L0 重放形态（[user] 首行）→ scaffold", () => {
    const got = classifyInbound([u("[user]\n<current_feeling>平静</current_feeling>")]);
    expect(got.classified[0].classification).toBe("scaffold");
  });

  it("Me4 覆盖：粘贴未知根标签工件单独出现 → artifact（残差空但保留不丢）", () => {
    const got = classifyInbound([u('<foo bar="1">xyz</foo>')]);
    expect(got.classified[0].classification).toBe("artifact");
  });

  it("Me4 覆盖：多协议块共存 + 真实提问 → real", () => {
    const got = classifyInbound([u('<system-reminder>context stuff</system-reminder>\n<acp tokens="1">m1</acp>\n真实提问：部署后验证了吗？')]);
    expect(got.classified[0].classification).toBe("real");
  });
});
