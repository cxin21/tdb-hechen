/**
 * 阶段 4 / P4-A：场合氛围（scene）—— 纯函数，零网络、零 LLM。
 *
 * 解决什么问题：同一句「帮我看下」在闲聊里和在催交付里，该用的回答形状不一样。
 * 人格卡（system prompt 稳定前缀）回答「我是谁」，这件事回答「此刻该怎么接」——
 * 它按轮变化，所以只能进 volatile 段（append-only 尾部），不能进稳定前缀
 * （进了就是每轮换前缀，KV cache 全失效）。
 *
 * 判据全部写死、可复算：七个信号各 0..1，带固定权重求和，两档阈值 0.38/0.62。
 * 不做模型判断，是因为「此刻语气」必须可解释、可回放；模型判断留给人格层。
 */

export type SceneTone = '松' | '常' | '收';

export interface SceneInput {
  /** 本轮用户原话。 */
  lastUserText: string;
  /** 同会话最近几轮用户原话（不含本轮），用于判断节奏是否连续。 */
  recentUserTexts: string[];
  /** 距上一条用户消息的毫秒数；缺省视为「不急」（不参与调速）。 */
  gapMs?: number;
  /** 群聊场景（已知时传入；当前不改变档位，只写进 signals 便于回放）。 */
  isGroup?: boolean;
}

export interface SceneResult {
  tone: SceneTone;
  line: string;
  signals: Record<string, number>;
}

/** 三档固定话术，均 ≤60 字（判据）。写死常量：同一输入必须永远同一输出。 */
export const SCENE_LINES: Record<SceneTone, string> = {
  松: '对方在闲聊，短句接住，别提前交作业。',
  常: '正常推进，先结论后理由。',
  收: '对方在等你交付，先给结论，别铺陈。',
};

const SCENE_LINE_MAX_CHARS = 60;
const SCENE_SHOU = 0.62;
const SCENE_SONG = 0.38;

const POLITE = ['请', '麻烦', '谢谢', '辛苦'];
const HONORIFIC = ['您', '老师', '经理'];

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function countOccurrences(text: string, needles: string[]): number {
  let total = 0;
  for (const needle of needles) {
    if (needle === '') continue;
    let from = 0;
    for (;;) {
      const at = text.indexOf(needle, from);
      if (at < 0) break;
      total += 1;
      from = at + needle.length;
    }
  }
  return total;
}

/** emoji 占比：只数代理对与常见符号区，避免把中文当 emoji。 */
function emojiCount(text: string): number {
  let n = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (cp >= 0x1f300 && cp <= 0x1faff) n += 1;
    else if (cp >= 0x2600 && cp <= 0x27bf) n += 1;
  }
  return n;
}

function normalized(text: string): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 七个信号，每项都按「越像交付越接近 1」的方向算，所以加权和越大越「收」。
 * 这样只有一个方向要调，不会出现「某项高反而更松」的隐藏耦合。
 */
function signalsOf(input: SceneInput): Record<string, number> {
  const last = normalized(input.lastUserText);
  const recent = Array.isArray(input.recentUserTexts) ? input.recentUserTexts.map(normalized).filter(Boolean) : [];
  const all = [...recent, last].filter(Boolean);
  const chars = Math.max(1, last.length);

  const lengths = (all.length > 0 ? all : [last]).map((t) => t.length);
  const avgLen = lengths.reduce((a, b) => a + b, 0) / Math.max(1, lengths.length);
  const lengthSignal = clamp01(avgLen / 60);

  const punct = countOccurrences(last, ['，', '。', '！', '？', '；', '：', ',', '.', '!', '?', ';']);
  const punctSignal = clamp01(punct / chars / 0.12);

  const emojiSignal = 1 - clamp01(emojiCount(last) / chars / 0.05);

  const politeSignal = countOccurrences(last, POLITE) > 0 ? 1 : 0;

  const fences = (last.match(/```/g) ?? []).length;
  const headings = (last.match(/^#{1,6}\s/gm) ?? []).length;
  const inlineCode = (last.match(/`[^`]+`/g) ?? []).length;
  const mdSignal = clamp01((fences + headings * 2 + inlineCode) / 3);

  const honorificSignal = countOccurrences(last, HONORIFIC) > 0 ? 1 : 0;

  // 节奏：快 → 松（0），慢 → 收（1）；缺省 0.5（不表态）。
  let rhythmSignal = 0.5;
  if (typeof input.gapMs === 'number' && Number.isFinite(input.gapMs) && input.gapMs >= 0) {
    if (input.gapMs < 120_000) rhythmSignal = 0.2;
    else if (input.gapMs > 3_600_000) rhythmSignal = 0.8;
    else rhythmSignal = 0.5;
  }

  return {
    length: lengthSignal,
    punct: punctSignal,
    emoji: emojiSignal,
    polite: politeSignal,
    markdown: mdSignal,
    honorific: honorificSignal,
    rhythm: rhythmSignal,
  };
}

const WEIGHTS: Record<string, number> = {
  length: 0.15,
  punct: 0.1,
  emoji: 0.1,
  polite: 0.1,
  markdown: 0.25,
  honorific: 0.15,
  rhythm: 0.15,
};

function scoreOf(signals: Record<string, number>): number {
  let score = 0;
  for (const [key, weight] of Object.entries(WEIGHTS)) {
    score += weight * clamp01(signals[key] ?? 0);
  }
  return clamp01(score);
}

function toneOf(score: number): SceneTone {
  if (score >= SCENE_SHOU) return '收';
  if (score <= SCENE_SONG) return '松';
  return '常';
}

/**
 * 空输入 → 「常」：拿不到这一轮的话时，不要凭空收紧或放松对方。
 * `line` 一定 ≤60 字（构造保证 + 测试守护），因为它要和其它片段共享 volatile 预算。
 */
export function computeScene(input: SceneInput): SceneResult {
  const signals = signalsOf(input ?? { lastUserText: '', recentUserTexts: [] });
  const score = scoreOf(signals);
  // 分数进 signals 是为了可回放：出问题时能直接看「哪个信号把它推到这一档」，
  // 不用凭三档结论反猜。
  const withScore: Record<string, number> = { ...signals, score };
  const last = normalized(input?.lastUserText ?? '');
  if (last === '') {
    return { tone: '常', line: SCENE_LINES['常'], signals: withScore };
  }
  const tone = toneOf(score);
  const line = SCENE_LINES[tone].slice(0, SCENE_LINE_MAX_CHARS);
  if (input?.isGroup === true) {
    // 群聊不改档位，只留个可回放的标记（当前没有据此改变话术的证据）。
    return { tone, line, signals: { ...withScore, group: 1 } };
  }
  return { tone, line, signals: withScore };
}

/** 注入时的一行：稳定前缀（`场合：`）只为可读，档位话术本身不带任何内部词。 */
export function formatSceneLine(result: SceneResult): string {
  return '场合：' + result.line;
}