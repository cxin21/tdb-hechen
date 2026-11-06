/**
 * soul/slots.ts —— 追责判定：从「一条大词表」改成「四个可独立验证的槽」。
 *
 * 为什么（2026-11-06 实测，证据见 docs/soul-self-maintenance.md §6）：
 *  - 单条 BLAME 正则在 358 条干净语料上召回 51.3%，漏「不管用/报错」这类不带「不对」的报障；
 *  - 放宽词表后，盲测 42 条（10 正）上精确率从 .95 掉到 .22 —— 我的回复「已修好」几乎句句都有，
 *    拿它当判据等于把派活句（「有问题的都处理一下吧」）全收进来；
 *  - 冻结后的锚点版在同一 42 条上是 .86/.60（tp6 fp1 fn4），靠的是「具体物件 + 负向描述」，
 *    不靠情绪词，也不靠我的回复。
 *
 * 槽位（每个槽都能单独复核，漏一个词只坏一个槽，不会让整条事件消失）：
 *   anchor（ART）   他指的是一个具体物件：界面/页面/列表/按钮/附件/搜索/刷新/接口/日志/提取…
 *   behavior（BEH） 他描述了一个具体行为：报错/不管用/没反应/打不开/不合法/不显示/超过 N 条…
 *   negative（NEG） 负向描述：不对/有问题/丑/难看/别扭/为什么/怎么/不行…
 *   recurrence      他说「还是/又/依然」+ 我上一轮确实自称已修（两边都要，缺一不算）
 *   veto            对方案/需求范围的否决：「需求中没有说吧」「这就是你设计的 UI」
 *   taskLike        派活前缀（先落票/你再检查/调整一下/有问题的都…）：是在派活，不是在挑错
 *   quoted          引述提问模板：不算他的判断
 *
 * blame = veto | recurrence | (behavior & why & 指向我) | (anchor & negative & !taskLike)
 *
 * 诚实边界：.86/.60 是 42 条上重拟合后的样本内数字，不是盲测；换语料（英文/其他用户）仍需重标。
 * 只有一句抽象评价（「根本不是人格」）目前记不到，宁缺毋编。
 */

export interface BlameTurnContext {
  /** 我对他这句话的回复（下一轮 assistant 原文）——只做诊断，不参与判定。 */
  reply?: string;
  /** 他开口之前，我上一轮是否自称已修（复发槽需要）。 */
  prevClaimedFix?: boolean;
}

export interface BlameSlots {
  anchor: boolean;
  behavior: boolean;
  negative: boolean;
  recurrence: boolean;
  whyQuestion: boolean;
  designVeto: boolean;
  taskLike: boolean;
  quoted: boolean;
  /** 我的回复承认了——诊断用，不参与 blame（盲测证明它会灌进大量派活句）。 */
  confirmedByReply: boolean;
  blame: boolean;
  /** 人类可复核的判定理由，写进 episode.signals。 */
  reason: string;
}

/** 具体物件：他说的是「哪一块」，不是「整体怎么样」。 */
const ANCHOR =
  /(?:UI|界面|页面|工作台|列表|按钮|附件|搜索|刷新|接口|样式|间距|缩进|弹窗|卡片|详情|设置|组件|控制台|日志|渲染|字体|颜色|对齐|面板|菜单|输入框|下拉|上传|下载|跳转|提取|记忆|召回|提案|工具栏|侧栏|导航)/u;
/** 具体行为：可以复现的现象。 */
const BEHAVIOR =
  /(?:报错|异常|不管用|没反应|打不开|白屏|崩|卡死|卡住|不合法|不显示|没显示|不能切换|不可点|超时|没生效|不生效|没有数据|没有收到|没收到|缺失|漏了|重复|顺序不对|错位|闪|抖动|超过|都\d+条|没有恢复|不恢复)/u;
/** 负向描述。 */
const NEGATIVE =
  /(?:不对|有问题|为什么|怎么|不行|没用|难看|丑|别扭|乱|离谱|差|不对吧|不够|太多|太少|还是)/u;
/** 我上一轮自称已修：只认明确的完成措辞，不认泛泛的「已」。 */
const CLAIMED_FIX = /(?:已修好|已改好|已修复|改完了|已上线|已部署|已重做|已补上|已按|已对齐|已实现|已处理|已落库)/u;
const PERSIST = /(?:还是|又|依然|仍然)/u;
const WHY = /(?:为什么|怎么还|怎么又|到底|是不是你)/u;
/** 否决：对方案/需求范围本身不认。 */
const VETO = /(?:需求(?:中|里)?(?:没有|没说)|这就是你设计的|不是要求.{0,10}(?:用|按|组件)|还不如用|用组件库了么)/u;
/** 派活前缀：这些是在给我派任务，不是在挑我的错。 */
const TASK_HEAD =
  /^(?:先把|先落票|先做|先跑|先按|按.{0,12}(?:顺序|方案)|进行.{0,8}测试|安装一下|帮我|开始|继续|现在补|落票|提个issue|调整一下|遗留问题|全部有问题|有问题的都|有则修改|有问题的描述|builder\s*续接)/u;
/** 「你再分析/检查一下…」常出现在句中（前面还带着问题描述），但整句的落点是派活。 */
const TASK_ANYWHERE = /(?:你再(?:检查|看看|验证|分析|确认|整理|设计)|你验证一下)/u;
/** 引述提问模板：他念的是「该怎么问」，不是他的判断。 */
const QUOTED = /(?:这样问|就这样问|按这个(?:问|说)|逐个位置)/u;
/** 我的回复承认了（诊断用）。 */
const REPLY_ACK = /(?:改|修|补|已按|重做|你说得对|您批评得对|你的质疑有道理|核实|核查|根因)/u;

export function claimOfFix(text: string | undefined): boolean {
  return CLAIMED_FIX.test(text ?? "");
}

export function appraiseBlameSlots(text: string, ctx?: BlameTurnContext): BlameSlots {
  const u = (text ?? "").trim();
  const anchor = ANCHOR.test(u);
  const behavior = BEHAVIOR.test(u);
  const negative = NEGATIVE.test(u);
  const recurrence = PERSIST.test(u) && ctx?.prevClaimedFix === true;
  const whyQuestion = WHY.test(u) && /(?:你|您)/u.test(u);
  const designVeto = VETO.test(u);
  const taskLike = TASK_HEAD.test(u) || TASK_ANYWHERE.test(u);
  const quoted = QUOTED.test(u);
  const blame =
    !quoted && !taskLike && (designVeto || recurrence || (behavior && whyQuestion) || (anchor && (negative || behavior)));
  const reasons: string[] = [];
  if (anchor) reasons.push("anchor");
  if (behavior) reasons.push("behavior");
  if (negative) reasons.push("negative");
  if (recurrence) reasons.push("recurrence");
  if (whyQuestion) reasons.push("why");
  if (designVeto) reasons.push("veto");
  if (taskLike) reasons.push("task");
  if (quoted) reasons.push("quoted");
  const reply = (ctx?.reply ?? "").trim();
  return {
    anchor,
    behavior,
    negative,
    recurrence,
    whyQuestion,
    designVeto,
    taskLike,
    quoted,
    confirmedByReply: reply !== "" && REPLY_ACK.test(reply),
    blame,
    reason: reasons.length > 0 ? reasons.join("+") : "no-signal",
  };
}
