import { describe, it, expect } from "vitest";
import { annotateAgentNarration, isAgentNarration, reconcileAgentNarrationMetadata } from "./agent-narration.js";

/**
 * A3-2（2026-11-02）：agent 自述标注（config-first）。
 *
 * 语义取自 prompts/l1-extraction.ts 的 AGENT_ACT_BLOCK：主语是"我/AI 自己"，
 * 谓语描述 AI 自身的行为/职责/承诺/工作风格 —— 而不是"用户说的话"。
 * 只在 cfg.extraction.actorTagging === true 时写 metadata.actor="agent"；
 * 关闭/未命中一律不写该字段（保持今天的字节形态）。
 */

const ON = { extraction: { actorTagging: true } };
const OFF = { extraction: { actorTagging: false } };

const mem = (content: string, metadata?: Record<string, unknown>) =>
  metadata === undefined ? { content } : { content, metadata };

describe("A3-2 isAgentNarration（纯判定）", () => {
  it("中文第一人称自述（承诺/职责/红线）→ true", () => {
    expect(isAgentNarration("我在对话中承诺每周五出周报并坚持执行")).toBe(true);
    expect(isAgentNarration("我长期承担每日 07:00 给用户推送上蔡县天气")).toBe(true);
    expect(isAgentNarration("我在任务被环境阻塞时执行红线：先报障再等指示")).toBe(true);
    expect(isAgentNarration("我负责维护 L1 抽取流水线的稳定性")).toBe(true);
  });

  it("用户陈述反例（「用户让我…」）→ false", () => {
    expect(isAgentNarration("用户让我把脚本改成异步")).toBe(false);
    expect(isAgentNarration("用户（何晨）要求我每周五交周报")).toBe(false);
  });

  it("第三人称/无主语 → false", () => {
    expect(isAgentNarration("何晨每周五出周报")).toBe(false);
    expect(isAgentNarration("L1 抽取流水线每批调用两次 LLM")).toBe(false);
  });

  it("英文第一人称自述 → true；英文用户陈述 → false", () => {
    expect(isAgentNarration("I always run the full test suite before committing")).toBe(true);
    expect(isAgentNarration("I promised to send the weekly report every Friday")).toBe(true);
    expect(isAgentNarration("The user asked me to rewrite the script")).toBe(false);
  });

  it("空串/空白/非法输入 → false（不炸）", () => {
    expect(isAgentNarration("")).toBe(false);
    expect(isAgentNarration("   \n\t ")).toBe(false);
    expect(isAgentNarration(undefined as unknown as string)).toBe(false);
    expect(isAgentNarration(null as unknown as string)).toBe(false);
  });

  it("第一人称但非 AI 行为（用户偏好句）→ false（宁缺毋滥）", () => {
    expect(isAgentNarration("我喜欢喝美式咖啡")).toBe(false);
  });
});

/**
 * F5（2026-11-02）：主语扩展 —— 「我 / AI / 助手 / 模型」四类自述主语必须同判。
 * 生产事实：全库 537 行以「AI」开头（2026-11-02 只读实测），旧实现命中 0。
 */
describe("F5 四类主语：我 / AI / 助手 / 模型", () => {
  it("「我」主语（既有口径不回归）", () => {
    expect(isAgentNarration("我在对话中承诺每周五出周报并坚持执行")).toBe(true);
  });

  it("「AI」主语：带日期状语 / 无空格动词 / 句中状语 都命中", () => {
    expect(isAgentNarration("AI 于 2026-10-14 完成 Task 7 代码评审")).toBe(true);
    expect(isAgentNarration("AI确认transformers.js 内建下载器被 hf-mirror 限流")).toBe(true);
    expect(isAgentNarration("AI 在分析中确认 PO200 参数主体注册不属于本工程代码范围")).toBe(true);
    expect(isAgentNarration("AI 完成了 A3 提取校准并跑了全量门禁")).toBe(true);
  });

  it("「助手」主语命中", () => {
    expect(isAgentNarration("助手在任务被环境阻塞时执行红线：先报障再等指示")).toBe(true);
    expect(isAgentNarration("助手已复核全部产出物")).toBe(true);
    expect(isAgentNarration("助手负责维护 L1 抽取流水线的稳定性")).toBe(true);
  });

  it("「模型」主语命中", () => {
    expect(isAgentNarration("模型在每轮抽取前核对红线注入")).toBe(true);
    expect(isAgentNarration("模型负责维护召回流水线的稳定性")).toBe(true);
  });

  it("「用户让我… / 用户要求 AI… / 用户让助手…」不误标", () => {
    expect(isAgentNarration("用户让我把脚本改成异步")).toBe(false);
    expect(isAgentNarration("用户要求 AI 每周五交周报")).toBe(false);
    expect(isAgentNarration("用户让助手复核产出物")).toBe(false);
    expect(isAgentNarration("The user asked the AI to rewrite the script")).toBe(false);
  });

  it("复合名词（模型配置 / 助手脚本 / AI 供应商）不误标", () => {
    expect(isAgentNarration("模型配置决定了召回顺序")).toBe(false);
    expect(isAgentNarration("助手脚本的参数在 yaml 里")).toBe(false);
    expect(isAgentNarration("AI 供应商的限流很严")).toBe(false);
  });

  it("AI 形状但无 agent 动作词 → 不误标", () => {
    expect(isAgentNarration("AI 是一个缩写")).toBe(false);
    expect(isAgentNarration("AI模型列表见配置页")).toBe(false);
  });
});

describe("A3-2 annotateAgentNarration（写 metadata）", () => {
  it('开关开 + 命中 → metadata.actor="agent"（保留原有 metadata 键）', () => {
    const out = annotateAgentNarration(mem("我承诺每周五出周报", { subject: "周报" }), ON);
    expect(out.metadata).toEqual({ subject: "周报", actor: "agent" });
  });

  it("开关开 + 命中 + 无 metadata → 新建 metadata（不炸）", () => {
    const out = annotateAgentNarration(mem("我长期负责维护召回流水线"), ON);
    expect(out.metadata).toEqual({ actor: "agent" });
  });

  it("开关开 + 未命中 → 不写 actor 字段", () => {
    const out = annotateAgentNarration(mem("用户（何晨）在用 NC 客开", {}), ON);
    expect(out.metadata).toEqual({});
    expect(Object.prototype.hasOwnProperty.call(out.metadata ?? {}, "actor")).toBe(false);
  });

  it("开关关（false/缺省/无配置）→ 绝不写 actor，且返回原对象（字节形态不变）", () => {
    for (const cfg of [OFF, {}, undefined, { extraction: {} }]) {
      const input = mem("我在对话中承诺每周五出周报", { subject: "周报" });
      const out = annotateAgentNarration(input, cfg as never);
      expect(out).toBe(input);
      expect(out.metadata).toEqual({ subject: "周报" });
    }
  });

  it("开关开但传入 undefined metadata + 未命中 → 不炸、不新增键", () => {
    const input = mem("用户让我改脚本");
    const out = annotateAgentNarration(input, ON);
    expect(out).toBe(input);
    expect(out.metadata).toBeUndefined();
  });
});

/**
 * A4（2026-11-03）：误判收口。修前实测四条误判（真实噪声）：
 *  - 「助手已完成的事项列表」「AI 已确认的合同清单」：动作词后接「的」是**定语**，不是谓语；
 *  - 「我明天提交周报」「我的笔记里写满了待办」：用户第一人称叙事，句中没有自指证据
 *    （旧实现只要句中出现动作词就判自述）。
 * 语义口径从此收敛为：先认主语，再认**句法关系**（第三人称=谓语位置；第一人称=自指证据）。
 */
describe("A4 误判收口：定语结构 + 第一人称自指证据", () => {
  it("第三人称：动作词接「(了|过)?的」构成定语 → false", () => {
    expect(isAgentNarration("助手已完成的事项列表")).toBe(false);
    expect(isAgentNarration("AI 已确认的合同清单")).toBe(false);
    expect(isAgentNarration("模型已修复的缺陷清单")).toBe(false);
    expect(isAgentNarration("AI 提交的周报已归档")).toBe(false);
  });

  it("第三人称：谓语位置的动作词不受影响（不回归）", () => {
    expect(isAgentNarration("AI 完成了 A3 提取校准并跑了全量门禁")).toBe(true);
    expect(isAgentNarration("助手已完成全部复核")).toBe(true);
    expect(isAgentNarration("助手负责维护 L1 抽取流水线的稳定性")).toBe(true);
  });

  it("第一人称：无自指证据的用户叙事 → false", () => {
    expect(isAgentNarration("我明天提交周报")).toBe(false);
    expect(isAgentNarration("我的笔记里写满了待办")).toBe(false);
    expect(isAgentNarration("我把钥匙放在抽屉里")).toBe(false);
  });

  it("第一人称：自指证据 + agent 动作 → true（含旧漏判）", () => {
    expect(isAgentNarration("我在和用户做记忆系统改造")).toBe(true);
    expect(isAgentNarration("我把 L0 捕获与召回缺陷定谳为输入混入")).toBe(true);
    expect(isAgentNarration("我于 2026-10-14 完成 Task 7 代码评审")).toBe(true);
    expect(isAgentNarration("作为 AI，我坚持每个修复先落失败用例")).toBe(true);
    expect(isAgentNarration("我已经跑完全量门并复核了差异")).toBe(true);
    expect(isAgentNarration("我负责维护 L1 抽取流水线的稳定性")).toBe(true);
    expect(isAgentNarration("我长期承担每日 07:00 给用户推送上蔡县天气")).toBe(true);
  });

  it("lead 样例矩阵：六条必须保持 false", () => {
    for (const text of [
      "API 报价已确认",
      "AIOps 平台已上线",
      "OpenAI 的接口超时",
      "模型参数写错了",
      "助手脚本的参数在 yaml 里",
      "用户要求 AI 回报六字段",
    ]) {
      expect(isAgentNarration(text), text).toBe(false);
    }
  });
});

/**
 * A4（2026-11-03）：dedup 合并会改写落库文本（l1-writer `merged_content ?? content`），
 * 而标签是在合并前打的。写侧必须在**最终 content** 上复判，否则双向错标：
 * 自述→非自述仍带标签（读侧误杀），非自述→自述漏标（读侧漏过）。
 */
describe("A4 reconcileAgentNarrationMetadata（按最终落库 content 复判）", () => {
  it("开关开 + 最终 content 是自述 → 打上 actor=agent（保留原有键）", () => {
    const md = reconcileAgentNarrationMetadata("我在和用户做记忆系统改造", { subject: "x" }, ON);
    expect(md).toEqual({ subject: "x", actor: "agent" });
  });

  it("开关开 + 最终 content 被改写为非自述 → 移除 actor（不留错标）", () => {
    const md = reconcileAgentNarrationMetadata("模型参数写错了", { subject: "x", actor: "agent" }, ON);
    expect(md).toEqual({ subject: "x" });
  });

  it("移除 actor 后无其它键 → undefined（与从未标注同形）", () => {
    expect(reconcileAgentNarrationMetadata("模型参数写错了", { actor: "agent" }, ON)).toBeUndefined();
  });

  it("无变化时返回原引用（零额外分配）；开关关恒等", () => {
    const tagged = { actor: "agent", subject: "x" };
    expect(reconcileAgentNarrationMetadata("我承诺每周五出周报", tagged, ON)).toBe(tagged);
    const plain = { subject: "x" };
    expect(reconcileAgentNarrationMetadata("模型参数写错了", plain, ON)).toBe(plain);
    expect(reconcileAgentNarrationMetadata("我承诺每周五出周报", plain, OFF)).toBe(plain);
    expect(reconcileAgentNarrationMetadata("模型参数写错了", undefined, ON)).toBeUndefined();
  });
});

/**
 * A5（2026-11-03，Lead 追加契约）：第一人称**完成体**。
 * 本仓 agent 报告的标准句式是「我 + 完成体（已/了/过，可带结果补语）+ 执行类动词 + 产物宾语」
 * （`我完成了 A3 提取校准并跑了全量门禁`）——这类真自述必须 true，否则 selfNarrationRate 会
 * 系统性低估（实跑 26.4%→19.4% 掉的就是这类）。边界：
 *  - `我的 NP`（领属）不构成自指证据，优先排除（`我的笔记里写满了待办` 仍 false）；
 *  - 无完成体的计划/叙事（明天、要、将）仍 false（`我明天提交周报`）；
 *  - `我把…` 只在动作属执行类时成立：`我把 L0…定谳…` true，`我把钥匙放在抽屉里` false
 *    ——区分靠动作词表，不靠「把」字本身。
 */
describe("A5 第一人称完成体：我 + 已/了/过 + 执行类动词", () => {
  // 逐条 it（不用 for 循环）：每条独立报告 expected/received，RED 留档可逐句对账。
  it.each([
    "我完成了 A3 提取校准并跑了全量门禁",
    "我核验了生产库 valid_end 行数为 106",
    "我已经跑完全量门",
    "我读完了 L1 抽取流水线源码并留下了行号锚",
  ])("agent 报告标准句式 → true：%s", (text) => {
    expect(isAgentNarration(text), text).toBe(true);
  });

  it.each(["我明天提交周报", "我的笔记里写满了待办", "我把钥匙放在抽屉里"])(
    "领属 / 无完成体的计划句 → 仍 false：%s",
    (text) => {
      expect(isAgentNarration(text), text).toBe(false);
    },
  );

  // 契约 c 的显式清单：`明天、要、将` 是计划标记，不是自指证据（A4 证据表曾把 要/将 当证据）。
  it.each(["我明天要提交周报", "我下周将提交周报", "我会在周五汇报进度"])(
    "计划标记（要/将/会）+ 无完成体 → false：%s",
    (text) => {
      expect(isAgentNarration(text), text).toBe(false);
    },
  );
});

/**
 * A6（2026-11-03）：三族「自指证据」——身份自报 / 风格准则 / 取证动作。
 *
 * 为什么这三族比「完成体」更安全（Lead 拍板口径，宁可窄不许宽）：
 *  - 完成体只看时体（我+了/已/过+执行类动词），中文里用户同样会说「我昨天提交了周报」，
 *    形态与 agent 报告完全同形，只能靠「宁可多标 agent」兜底；
 *  - 身份自报的主语必然是 AI 自己（「我是…助手」），人类不会这样指称自己；
 *  - 风格准则（我按/遵循…）与取证动作（我用…证明）都在陈述**自己的工作方式与取证行为**，
 *    且都带宾语约束（第三人称指示词、证据动词白名单），不是「含 AI 即算」。
 *  三族任一命中即 true；它们都不触碰 A5 的边界（领属 `我的 NP`、无完成体计划句、`我把钥匙…`）。
 */
describe("A6 三族自指证据：身份自报 / 风格准则 / 取证动作", () => {
  it.each([
    "我是工作台默认助手 default-agent-hechen",
    "我是 AI，负责召回选线与注入预算",
    "本人是当前会话的 Team Lead 助手",
  ])("身份自报 → true：%s", (text) => {
    expect(isAgentNarration(text), text).toBe(true);
  });

  // 人类身份 / 日期叙述：没有 agent 身份名词，或名词前的定语带「的」（人类的所属关系）。
  it.each(["我是用友的产品经理", "我是 2026-10 入职的", "我是负责采购域的同事"])(
    "人类身份 / 领属定语 → false：%s",
    (text) => {
      expect(isAgentNarration(text), text).toBe(false);
    },
  );

  it.each(["我按「宁缺勿滥」守住评审边界", "我遵循「先取证后定案」的纪律", "我奉行只读取证、不擅自提交"])(
    "风格准则 → true：%s",
    (text) => {
      expect(isAgentNarration(text), text).toBe(true);
    },
  );

  // 宾语里出现第三人称指示词（他/她/用户/客户/对方/某人）= 转述他人建议，属用户叙事。
  it.each(["我按照他的建议改了口径", "我按用户要求调整了口径", "我依对方的说法定了阈值"])(
    "转述第三方建议 → false：%s",
    (text) => {
      expect(isAgentNarration(text), text).toBe(false);
    },
  );

  it.each([
    "我用反向探针证明门禁会 FAIL",
    "我核查后指出 core.md 中全部 file:line 因代码树变动而失准",
    "我通过 A/B 探针确认注入字符下降 38%",
  ])("取证动作 → true：%s", (text) => {
    expect(isAgentNarration(text), text).toBe(true);
  });

  // 无证据动词：`用` 只是工具介词，可能完全是用户日常叙事。
  it.each(["我用微信发给客户了", "我靠工资生活"])("无证据动词 → false：%s", (text) => {
    expect(isAgentNarration(text), text).toBe(false);
  });

  // A6 不得把 A5 已收口的边界重新放宽。
  it.each(["我明天提交周报", "我的笔记里写满了待办", "我把钥匙放在抽屉里"])("A6 不放宽 A5 边界 → false：%s", (text) => {
    expect(isAgentNarration(text), text).toBe(false);
  });
});
