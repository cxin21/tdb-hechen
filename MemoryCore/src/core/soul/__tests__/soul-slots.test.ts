import { describe, expect, it } from "vitest";
import { appraiseBlameSlots, claimOfFix } from "../slots.js";

describe("追责槽位：锚点 + 负向描述，不靠情绪词也不靠我的回复", () => {
  it("具体物件 + 负向描述即可成立（「不管用/没附件」）", () => {
    const s = appraiseBlameSlots("点击添加到当前会话不管用，当前会话对话框还是没有附件");
    expect(s.anchor).toBe(true);
    expect(s.blame).toBe(true);
  });

  it("裸报障也成立：「搜索框搜索报错参数不合法」", () => {
    const s = appraiseBlameSlots("现在搜索框搜索报错参数不合法");
    expect(s.blame).toBe(true);
  });

  it("派活句里嵌缺陷词不算追责", () => {
    const s = appraiseBlameSlots("你再检查一下未提交的改动看看有没有有问题的", {
      reply: "盘点干净：7 M + 1 新测试。",
    });
    expect(s.taskLike).toBe(true);
    expect(s.blame).toBe(false);
  });

  it("「有问题的都处理一下吧」是派活，不是挑错", () => {
    const s = appraiseBlameSlots("有问题的都处理一下吧", { reply: "已修好两处。" });
    expect(s.blame).toBe(false);
  });

  it("我的回复「已修好」不能单独把派活句变成追责（盲测里的误报来源）", () => {
    const s = appraiseBlameSlots("调整一下有问题的描述推git，然后重编译panel", { reply: "已改好并推送。" });
    expect(s.confirmedByReply).toBe(true);
    expect(s.blame).toBe(false);
  });

  it("复发：他说「还是」，而我上一轮明确自称已修", () => {
    const s = appraiseBlameSlots("切换工作区后列表还是显示没有调度通道", {
      prevClaimedFix: claimOfFix("切换工作区现在会真正按所选 cwd 重读，已修好"),
    });
    expect(s.recurrence).toBe(true);
    expect(s.blame).toBe(true);
  });

  it("说「还是」但我上一轮没声称修过，不按复发算", () => {
    const s = appraiseBlameSlots("还是编辑后自动计算吧，校验改到点击结算按钮时校验", {
      prevClaimedFix: claimOfFix("我先把方案列出来"),
    });
    expect(s.recurrence).toBe(false);
  });

  it("对需求范围的否决不需要物件词", () => {
    const s = appraiseBlameSlots("需求中没有说有后台结算 / 自动结算按钮吧，查询页面只有四个分摊按钮");
    expect(s.designVeto).toBe(true);
    expect(s.blame).toBe(true);
  });

  it("「这就是你设计的UI」是追责，不是问句", () => {
    const s = appraiseBlameSlots("这就是你设计的UI？你用组件库了么，怎么还有很多原始样式的地方");
    expect(s.blame).toBe(true);
  });

  it("引述提问模板不算他的判断", () => {
    const s = appraiseBlameSlots("你识图的时候就这样问：逐个位置指出难看/不协调的地方", {
      reply: "改：把卡片间距按 16px 轨道重排。",
    });
    expect(s.quoted).toBe(true);
    expect(s.blame).toBe(false);
  });

  it("抽象评价（「根本不是人格」）暂时记不到：宁缺毋编", () => {
    const s = appraiseBlameSlots("我们这个问题太大了，根本不是人格，全是方法论和做过的事情");
    expect(s.blame).toBe(false);
  });

  it("句中派活（「…你再分析一下需求文档」）不算追责", () => {
    const s = appraiseBlameSlots("你再分析一下需求文档、不同分摊类型对应的字段的编辑性怎么处理，看看标准产品的其他页面");
    expect(s.taskLike).toBe(true);
    expect(s.blame).toBe(false);
  });

  it("Lead 的 builder 续接交办不是他挑我的错", () => {
    const s = appraiseBlameSlots("builder 续接：t13（#26 调度器核心）你在收尾期中断——产出 2 文件在场");
    expect(s.taskLike).toBe(true);
    expect(s.blame).toBe(false);
  });
});
