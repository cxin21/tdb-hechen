/**
 * S4 判侧提示词：给一个人格做「证据计票」（spec §3.1 判侧契约）。
 *
 * 信息屏障（spec §3.1 / 判据 12）：判侧只看到
 *   本轮事件 + 六轴行为锚 + 计票规则 + 输出 schema + 已有标签名，
 * 永远看不到当前卡文本、当前轴数值、上一轮的票。否则同一个模型一边看着
 * 「我现在严谨 0.72」一边给自己投票，权重只会自我强化——那是自证循环，不是漂移。
 * 这条约束不靠调用方自觉：本模块的导入面里只有 traits（六轴常量与种子标签名），
 * 没有 card / store / 特质状态读侧，想漏也没得漏。
 */
import { AXIS_ANCHORS, AXIS_LABELS, SEED_LABELS, SOUL_AXES, TRAIT_PROTOCOL_VERSION } from "./traits.js";
import type { SoulEpisode } from "./types.js";

/** 六轴行为锚：一轴一行，锚文案是 traits.ts 里那份唯一真源。 */
const AXIS_LINES = SOUL_AXES.map((axis) => {
  const anchor = AXIS_ANCHORS[axis];
  return `· ${axis}（${AXIS_LABELS[axis]}） 高：${anchor.high}；低：${anchor.low}`;
});

/**
 * 已有标签只给名字（spec §3.1 判侧可见面就是「已有标签名」）。
 * 不给 definition / gloss：traits.ts 现有 18 条种子里有 14 条 definition 与 gloss
 * 一字不差，而 gloss 是进卡文本——judge 看到它会开始模仿卡的口气，把计票写成
 * 性格描写。只留名字既能去重（规则 5）又不会把卡文本带进来（判据 12）。
 */
const LABEL_LINES = [
  `已有标签名（新标签必须与它们可区分；同义请复用，不要造新词）：${SEED_LABELS.map((label) => label.label).join("、")}`,
  "提新标签时 gloss 必填：一句 ≤40 字、写他具体怎么表现（例：没验到自己眼睛看过就不算完），不写评价词、不写轴名、不写数值。",
];

export const TRAIT_JUDGE_SYSTEM_PROMPT = [
  `[TRAIT-PROTOCOL ${TRAIT_PROTOCOL_VERSION}]`,
  "你在给一个人格做「证据计票」。你不决定数值，不写结论，不做心理分析。",
  "",
  "输入：本轮事件。每条给 episode_id、user_stance（他当时的原话/要求）、agent_stance（我当时的说法/做法）、outcome（后续结果）、quote（可引用的原句）。",
  "输出：只输出下面这一个 JSON 对象，不要解释，不要围栏：",
  '{"votes":[{"episode_id":"ep-…","axis":"rigor","delta":1,"quote":"原文片段","why":"一句话理由"}],"label_proposals":[{"label":"…","definition":"…","gloss":"一句 ≤40 字的行为注解，写他具体怎么表现，不写评价词","direction":{"warmth":0,"agency":0,"rigor":1,"openness":0,"stability":0,"boundary":0},"evidence_ids":["ep-…"]}]}',
  "没有要投的票就给空数组 votes；没有要提的新标签，label_proposals 也给空数组。",
  "",
  "六轴（每轴给高/低行为锚，只按锚判断，不看语气）：",
  ...AXIS_LINES,
  "注意：rigor = 做得对不对；boundary = 说得实不实。两者不要混。",
  "",
  "计票规则（全部硬性）：",
  "1. 只对显式行为计票，无证据不投。事件里没出现的行为不要替它补。",
  "2. 每条事件最多两个轴，每轴只 ±1。不要给小数，不要凑总数。",
  "3. 不复述人格、不推断动机、不因语气礼貌加分。",
  "4. direction 是载荷不是数值：它表示这个标签把六轴往哪边推，不表示「现在是多少」。",
  "5. 新标签必须可区分；和已有标签同义就复用，不要造新词。",
  "",
  ...LABEL_LINES,
].join("\n");

/**
 * 判侧 user prompt：只搬运事件本身（立场原句 + 结果 + 引文），
 * 不带情绪读数、强度、时间窗等可反推当前人格的字段。
 */
export function buildTraitJudgePrompt(episodes: readonly SoulEpisode[]): string {
  const blocks = episodes.map((episode) => {
    const lines = [
      `episode_id: ${episode.episodeId}`,
      `kind: ${episode.kind}`,
      `user_stance: ${episode.userStance}`,
      `agent_stance: ${episode.agentStance}`,
    ];
    if (episode.outcome) lines.push(`outcome: ${episode.outcome}`);
    if (episode.quote?.text) lines.push(`quote: ${episode.quote.text}`);
    return lines.join("\n");
  });
  return [
    `本轮事件 ${episodes.length} 条（投票只能引用下面出现过的 episode_id）：`,
    ...(blocks.length > 0 ? blocks : ["（本轮没有事件：返回空 votes 与空 label_proposals）"]),
    "只投上面出现过的 episode_id；没有显式行为就返回空 votes。",
  ].join("\n\n");
}
