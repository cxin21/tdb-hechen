/**
 * task-91 · 插件侧注入识别放宽到与 core 同规则。
 *
 * 缺陷：looksLikeInjectedBlock 旧实现只看「第一个非空行 trimmed」，比 core 严 ⇒
 * 「首行标记 + 缩进标记」「CRLF」「行首零宽字符」三种形态在我们自己渲染的块上
 * 会被判成真实发言写回 L0（自我中毒）。
 *
 * 本套件锁两件事：
 *   ① 与 core 逐项对齐（常量、标记表、归一化、判定结论必须一模一样）；
 *   ② 放宽不越界：正文中段引用、句中引用、标记内部插零宽 仍然放行。
 *
 * core 真源：MemoryCore/src/gateway/injection-guard.ts:99-188（同仓，直接 import 对拍，
 * 不做「抄一份再比字面量」——那只能证明我们抄对了，不能证明两实现等价）。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  INJECTION_TEXT_MARKERS,
  LEADING_INVISIBLE_CHARS_RE,
  LEADING_NON_EMPTY_LINE_LIMIT,
  MIN_MATCHED_SEGMENT_RATIO,
  detectInjectedBlock,
  looksLikeInjectedBlock,
  normalizeInjectionLines,
} from '../src/injection-markers.js';
import { formatVolatileBlock } from '../src/volatile.js';
import type { RecallHit } from '../src/recall-source.js';
import {
  INJECTED_BLOCK_MARKERS as CORE_MARKERS,
  LEADING_INVISIBLE_CHARS_RE as CORE_LEADING_RE,
  LEADING_NON_EMPTY_LINE_LIMIT as CORE_LEADING_LIMIT,
  MIN_MATCHED_SEGMENT_RATIO as CORE_RATIO,
  detectInjectedBlock as coreDetect,
  normalizeInjectionLines as coreNormalize,
} from '../../MemoryCore/src/gateway/injection-guard.ts';

/** 长正文中段引用（core 套件同一 fixture）：标记在第 8 个非空行、占比 13% ⇒ 放行。 */
const QUOTED_MID_BODY = [
  '我们前面聊了很多实现细节，先把今天的结论按顺序记下来，免得下周又忘：',
  '第一，L1 游标按 checkpoint 推进，不再依赖时间窗；',
  '第二，召回块不允许进 L0，否则每轮都会自我中毒；',
  '第三，守卫只认行首标记，句子里提到的不算；',
  '第四，wiki 转发走 8421，失败回落本地注册表；',
  '第五，typecheck 门禁按基线比对，不许重锁；',
  '第六，测试只跑相关文件，全量留给 lead。',
  '',
  '<soul-identity> 这一段是我贴出来给你看格式的，不是注入',
  '',
  '继续：第七，报告只给可验收事实，不写长篇分析；',
  '第八，未拍板的事写进「没做/风险」，不要自己决定。',
].join('\n');

describe('task-91 · 与 core 同源（常量 / 标记表 / 归一化）', () => {
  it('阈值常量与 core 同名同值，正则源逐字相同', () => {
    expect(LEADING_NON_EMPTY_LINE_LIMIT).toBe(3);
    expect(MIN_MATCHED_SEGMENT_RATIO).toBeCloseTo(0.3, 10);
    expect(LEADING_NON_EMPTY_LINE_LIMIT).toBe(CORE_LEADING_LIMIT);
    expect(MIN_MATCHED_SEGMENT_RATIO).toBe(CORE_RATIO);
    expect(LEADING_INVISIBLE_CHARS_RE.source).toBe(CORE_LEADING_RE.source);
    expect(LEADING_INVISIBLE_CHARS_RE.flags).toBe(CORE_LEADING_RE.flags);
  });

  it('标记集合与 core 逐项一致（9 条，含插件新增三类块）', () => {
    expect(INJECTION_TEXT_MARKERS).toHaveLength(9);
    expect([...INJECTION_TEXT_MARKERS].sort()).toEqual([...CORE_MARKERS].sort());
  });

  it('normalizeInjectionLines 与 core 对拍（CRLF/CR/tab/NBSP/全角空格/ZWSP 链/空行）', () => {
    const payloads = [
      '\r\n\t  <soul-identity>\r\n\u3000\u3000正文\r尾行',
      'a\n\n  b  c\n',
      '\u200b\u200c\u2060\u3000<team-wiki>\n正文',
      '\ufeff\u00a0\t【agemem 记忆提示】\n- 片段',
      '',
    ];
    for (const raw of payloads) {
      expect(normalizeInjectionLines(raw)).toEqual(coreNormalize(raw));
    }
  });
});

describe('task-91 · 放宽后必须命中的形态（旧实现全部逃逸）', () => {
  it('行首空格缩进（首行前缀 + 第二行缩进标记）', () => {
    const text = '前缀一句，下面是系统上下文：\n   <soul-identity>\n我是何晨的数字分身……\n</soul-identity>\n以上。';
    expect(detectInjectedBlock(text)).toBe('<soul-identity>');
    expect(coreDetect(text)).toBe('<soul-identity>');
  });

  it('tab 缩进', () => {
    const text = '系统提示：\n\t<relevant-memories>\n- 记忆 1\n- 记忆 2\n</relevant-memories>';
    expect(detectInjectedBlock(text)).toBe('<relevant-memories>');
  });

  it('CRLF 换行 + 缩进', () => {
    const text = '前缀\r\n  【币值判定规则】\r\n1 元 = 1 元……';
    expect(detectInjectedBlock(text)).toBe('【币值判定规则');
  });

  it('前导空行（三个空行后才出现标记）', () => {
    expect(detectInjectedBlock('\n\n\n【agemem 记忆提示】\n以下是召回块……')).toBe('【agemem 记忆提示】');
  });

  it('行首 ZWSP(U+200B) 零宽空格', () => {
    const text = ['prefix line', '\u200b<relevant-memories>', '- 记忆 1', '</relevant-memories>'].join('\n');
    expect(detectInjectedBlock(text)).toBe('<relevant-memories>');
  });

  it('行首 ZWNJ(U+200C)', () => {
    expect(detectInjectedBlock('\u200c<soul-identity>\n我是何晨的数字分身……\n</soul-identity>')).toBe('<soul-identity>');
  });

  it('行首 WORD JOINER(U+2060)', () => {
    expect(detectInjectedBlock('系统提示：\n\u2060【币值判定规则】\n1 元 = 1 元……')).toBe('【币值判定规则');
  });

  it('ZWSP + tab + 空格混合前缀', () => {
    const text = ['前缀一句：', '  \u200b\t【agemem 记忆提示】', '以下是召回块……'].join('\n');
    expect(detectInjectedBlock(text)).toBe('【agemem 记忆提示】');
  });

  it('超过前 3 个非空行、但命中段占非空白字符 ≥30%（兜底路径）', () => {
    const preamble = ['一句前缀', '二句前缀', '三句前缀', '四句前缀'].join('\n');
    const block =
      '<relevant-memories>\n- 很长的一段召回内容很长的一段召回内容\n- 更长更长更长更长更长更长更长更长\n</relevant-memories>';
    expect(detectInjectedBlock(preamble + '\n' + block)).toBe('<relevant-memories>');
    expect(coreDetect(preamble + '\n' + block)).toBe('<relevant-memories>');
  });
});

describe('task-91 · 放宽不越界（负例优先于正例）', () => {
  it('长正文中段引用（占比 13%、第 8 非空行）⇒ 放行', () => {
    expect(detectInjectedBlock(QUOTED_MID_BODY)).toBeUndefined();
    expect(coreDetect(QUOTED_MID_BODY)).toBeUndefined();
  });

  it('句中引用（标记不在行首）⇒ 放行', () => {
    const text = '我在日志里看到这段：【agemem 记忆提示】下面的内容是不是注入？';
    expect(detectInjectedBlock(text)).toBeUndefined();
    expect(looksLikeInjectedBlock(text)).toBe(false);
  });

  it('标记内部插零宽（<soul\u200b-identity>）⇒ 不认（Lead 终局裁决：只剥行首，标记内部不归一化）', () => {
    const text = '<soul\u200b-identity>\n我是何晨的数字分身……';
    expect(detectInjectedBlock(text)).toBeUndefined();
    expect(coreDetect(text)).toBeUndefined();
  });

  it('空串与纯空白 ⇒ 不命中', () => {
    expect(detectInjectedBlock('')).toBeUndefined();
    expect(detectInjectedBlock('   \n\t\n')).toBeUndefined();
    expect(looksLikeInjectedBlock('')).toBe(false);
  });
});

describe('task-91 · 我们自己的块必须被抓（真实渲染，不是手写 fixture）', () => {
  it('formatVolatileBlock 渲染出的召回块被判命中', () => {
    const hits: RecallHit[] = [
      { text: '用户偏好 pnpm workspace，不喜欢 npm install', layer: 'L1' },
      { text: '项目根 D:/TDB/td-agemem', layer: 'work_fact' },
    ];
    const rendered = formatVolatileBlock(hits, 1200);
    expect(rendered.startsWith('【agemem 记忆提示】')).toBe(true);
    expect(detectInjectedBlock(rendered)).toBe('【agemem 记忆提示】');
    expect(looksLikeInjectedBlock(rendered)).toBe(true);
  });

  it('把插件块整体缩进一层后仍被抓（宿主重排缩进的现实形态）', () => {
    const hits: RecallHit[] = [{ text: '偏好 pnpm', layer: 'L1' }];
    const indented = formatVolatileBlock(hits, 1200)
      .split('\n')
      .map((line) => '  ' + line)
      .join('\n');
    expect(detectInjectedBlock(indented)).toBe('【agemem 记忆提示】');
  });
});

describe('task-91 · 判定结论与 core 逐一相等（22 例 fixture 对拍）', () => {
  const ZWSP = '\u200b';
  const FIXTURES: string[] = [
    // 正例（core 套件 task-85/task-92 的原样 fixture）
    '前缀一句，下面是系统上下文：\n   <soul-identity>\n我是何晨的数字分身……\n</soul-identity>\n以上。',
    '系统提示：\n\t<relevant-memories>\n- 记忆 1\n- 记忆 2\n</relevant-memories>',
    '前缀\r\n  【币值判定规则】\r\n1 元 = 1 元……',
    '\n\n\n【agemem 记忆提示】\n以下是召回块……',
    '  <team-wiki>\n- 团队 wiki\n</team-wiki>',
    '<available_skills>\n- skill\n</available_skills>',
    '\t<core_memory>\n- 核心记忆\n</core_memory>',
    ['一句前缀', '二句前缀', '三句前缀', '四句前缀'].join('\n') +
      '\n<relevant-memories>\n- 很长的一段召回内容很长的一段召回内容\n- 更长更长更长更长更长更长更长更长\n</relevant-memories>',
    ['prefix line', ZWSP + '<relevant-memories>', '- 记忆 1', '</relevant-memories>'].join('\n'),
    ZWSP + '<soul-identity>\n我是何晨的数字分身……\n</soul-identity>',
    '系统提示：\n\u2060【币值判定规则】\n1 元 = 1 元……',
    ['前缀一句：', '  ' + ZWSP + '\t【agemem 记忆提示】', '以下是召回块……'].join('\n'),
    // 负例
    QUOTED_MID_BODY,
    QUOTED_MID_BODY.replace(
      '<soul-identity> 这一段是我贴出来给你看格式的，不是注入',
      ZWSP + '<soul-identity> 这一段是我贴出来给你看格式的，不是注入',
    ),
    '我在日志里看到这段：【agemem 记忆提示】下面的内容是不是注入？',
    '我在日志里看到这段：' + ZWSP + '【agemem 记忆提示】下面的内容是不是注入？',
    '真实提问：为什么 L1 游标不动？',
    '<soul\u200b-identity>\n我是何晨的数字分身……',
    '',
    '   \n\t\n',
  ];

  it('插件与 core 对同一 payload 给出同一个结论（20 例，含 12 正 8 负）', () => {
    const diffs: string[] = [];
    for (const payload of FIXTURES) {
      const pluginVerdict = detectInjectedBlock(payload) ?? null;
      const coreVerdict = coreDetect(payload) ?? null;
      if (pluginVerdict !== coreVerdict) {
        diffs.push(JSON.stringify({ payload: payload.slice(0, 40), pluginVerdict, coreVerdict }));
      }
    }
    expect(diffs).toEqual([]);
    expect(FIXTURES.filter((f) => detectInjectedBlock(f) !== undefined)).toHaveLength(12);
  });
});

describe('task-91 · 写回集成（行为变化落在 writeback 上，不只是纯函数）', () => {
  function setup() {
    const { createFakeContext } = require('./helpers/fake-ctx.js');
    return null as never;
  }

  it('无 source 的缩进注入块不再写进 L0（旧实现会落库，这就是自我中毒路径）', async () => {
    const { createFakeContext } = await import('./helpers/fake-ctx.js');
    const { installWriteback } = await import('../src/writeback.js');
    const { userMessage, assistantMessage } = await import('./helpers/messages.js');
    const fake = createFakeContext();
    const enqueue = vi.fn();
    installWriteback(fake.ctx, {
      outbox: { enqueue, flush: vi.fn(async () => {}) } as never,
      workspaceId: 'dsh',
      log: fake.ctx.logger,
    });
    // 宿主把 source 剥掉、并给块加了一层缩进（真实重排形态）
    fake.emit('session/event', { id: 's9' }, {
      type: 'user/message',
      data: { turn: 4, message: { role: 'user', content: [{ type: 'text', text: '  前缀一句：\n  【agemem 记忆提示】\n  - [L1] 偏好 pnpm' }] } },
    });
    fake.emit('session/event', { id: 's9' }, { type: 'user/message', data: { turn: 4, message: userMessage('真问题一句') } });
    fake.emit('session/event', { id: 's9' }, { type: 'assistant/message', data: { turn: 4, step: 1, message: assistantMessage('答') } });
    fake.emit('agent/turn-stopping', { turn: 4, agent: { session: { id: 's9' } } });

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][1].messages.map((m: any) => m.content)).toEqual(['真问题一句', '答']);
  });

  it('无 source 且行首带 ZWSP 的召回块同样不落库', async () => {
    const { createFakeContext } = await import('./helpers/fake-ctx.js');
    const { installWriteback } = await import('../src/writeback.js');
    const { userMessage, assistantMessage } = await import('./helpers/messages.js');
    const fake = createFakeContext();
    const enqueue = vi.fn();
    installWriteback(fake.ctx, {
      outbox: { enqueue, flush: vi.fn(async () => {}) } as never,
      workspaceId: 'dsh',
      log: fake.ctx.logger,
    });
    fake.emit('session/event', { id: 's8' }, {
      type: 'user/message',
      data: { turn: 5, message: { role: 'user', content: [{ type: 'text', text: '\u200b<relevant-memories>\n- [L1] 记忆' }] } },
    });
    fake.emit('session/event', { id: 's8' }, { type: 'user/message', data: { turn: 5, message: userMessage('真问题二句') } });
    fake.emit('session/event', { id: 's8' }, { type: 'assistant/message', data: { turn: 5, step: 1, message: assistantMessage('答2') } });
    fake.emit('agent/turn-stopping', { turn: 5, agent: { session: { id: 's8' } } });

    expect(enqueue.mock.calls[0][1].messages.map((m: any) => m.content)).toEqual(['真问题二句', '答2']);
  });
});
