import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ANSWER_CURRENCY_HEADER,
  ANSWER_CURRENCY_RULES,
  ANSWER_GUIDANCE_VERSION,
  ANSWER_PREFERENCE_HEADER,
  ANSWER_PREFERENCE_RULES,
  GUIDANCE_TEXT,
  GUIDANCE_VERSION,
  GUIDANCE_OVERRIDES_FROM_SINGLE_SOURCE,
  MEMORY_TOOLS_GUIDE,
  MEMORY_TOOLS_GUIDE_VERSION,
  buildAnswerGuidance,
  buildGuidance,
} from '../src/guidance.js';
import { apply } from '../src/index.js';
import { createFakeContext, runPreStep } from './helpers/fake-ctx.js';
import { userMessage } from './helpers/messages.js';

/**
 * task-15：dsh 注入路径的答案口径段。
 *
 * 两条防线：
 *  ① 内容契约——反拒答纪律必须在场，且与 MemoryCore 单一源逐字一致（直接读源码对拍）；
 *  ② 位置契约——口径进 system prompt 的独立 section，绝不进 volatile 的 user 消息。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = resolve(HERE, '../../MemoryCore/src/core/prompts');

function readCanon(name: string): string | null {
  const file = join(PROMPTS_DIR, name);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

const canonAnswer = readCanon('answer-guidance.ts');
const canonGuide = readCanon('memory-tools-guide.ts');

/** 读不到单一源时**跳过**（并在报告里能看到原因），不静默通过。 */
function itWithCanon(canon: string | null, name: string) {
  if (canon !== null) return it;
  console.warn(`[guidance.test] SKIP 逐字对拍：读不到 ${join(PROMPTS_DIR, name)}（需要单仓 checkout）`);
  return it.skip;
}

const fetchMock = vi.fn(async (input: any) => {
  const url = String(input?.url ?? input);
  if (url.includes('/v3/atomic/search')) {
    return new Response(JSON.stringify({ code: 0, data: { items: [{ content: 'recalled memory line', type: 'L1' }] } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('guidance: 内容与版本', () => {
  it('版本号可追溯到两份单一源', () => {
    expect(ANSWER_GUIDANCE_VERSION).toBe('prod-block-v2-currency+pref');
    expect(MEMORY_TOOLS_GUIDE_VERSION).toBe('memory-tools-guide-v2-tuned');
    expect(GUIDANCE_VERSION).toBe(ANSWER_GUIDANCE_VERSION + '|' + MEMORY_TOOLS_GUIDE_VERSION + '+dsh-tools');
  });

  it('反拒答纪律在场：有相关记录必须作答、工具不是放弃理由、只有完全无线索才说无法确定', () => {
    expect(ANSWER_CURRENCY_RULES[2]).toBe(
      '3. 只有当记忆里完全没有与该问题相关的内容时才拒答；有相关记录（哪怕是较早的）就必须给出答案，并注明该记录的时间。',
    );
    expect(MEMORY_TOOLS_GUIDE).toContain('不要因为记忆不完整而拒答');
    expect(MEMORY_TOOLS_GUIDE).toContain('只有已注入的记忆也完全没有相关线索时才说明无法确定');
    // 诱导拒答的旧框架一句都不许回来
    for (const banned of ['不足以回答用户问题时', '请直接根据已有信息回复', '说明该信息不在记忆中']) {
      expect(MEMORY_TOOLS_GUIDE).not.toContain(banned);
    }
  });

  it('工具清单按 dsh 真实工具面写：只提 memory_recall，不提 tdai_* 幻影工具', () => {
    expect(MEMORY_TOOLS_GUIDE).toContain('memory_recall');
    expect(MEMORY_TOOLS_GUIDE).not.toContain('tdai_');
    expect(GUIDANCE_OVERRIDES_FROM_SINGLE_SOURCE).toHaveLength(3);
  });

  it('buildAnswerGuidance 两段可独立关断；全关时零注入', () => {
    const both = buildAnswerGuidance();
    expect(both.startsWith(ANSWER_CURRENCY_HEADER)).toBe(true);
    expect(both).toContain(ANSWER_PREFERENCE_HEADER);
    expect(both.indexOf(ANSWER_CURRENCY_HEADER)).toBeLessThan(both.indexOf(ANSWER_PREFERENCE_HEADER));
    expect(buildAnswerGuidance({ currency: false })).not.toContain(ANSWER_CURRENCY_HEADER);
    expect(buildAnswerGuidance({ currency: false, preference: false })).toBe('');
  });

  it('buildGuidance = 答案口径 + 工具指南；toolsGuide 可单独关断', () => {
    expect(GUIDANCE_TEXT).toBe(buildGuidance());
    expect(GUIDANCE_TEXT.indexOf(ANSWER_CURRENCY_HEADER)).toBeLessThan(GUIDANCE_TEXT.indexOf('<memory-tools-guide>'));
    expect(buildGuidance({ toolsGuide: false })).toBe(buildAnswerGuidance());
  });
});

describe('guidance: 与 MemoryCore 单一源逐字对拍', () => {
  itWithCanon(canonAnswer, 'answer-guidance.ts')('答案口径标题与六条规则逐字出现在单一源里', () => {
    const source = canonAnswer as string;
    expect(source).toContain(ANSWER_GUIDANCE_VERSION);
    expect(source).toContain(ANSWER_CURRENCY_HEADER);
    expect(source).toContain(ANSWER_PREFERENCE_HEADER);
    for (const rule of [...ANSWER_CURRENCY_RULES, ...ANSWER_PREFERENCE_RULES]) {
      expect(source).toContain(rule);
    }
  });

  itWithCanon(canonAnswer, 'answer-guidance.ts')('渲染结果 = 单一源 buildAnswerGuidance 的段落形状（标题 + 编号规则，空行分隔）', () => {
    const source = canonAnswer as string;
    // 单一源的段落拼接规则：blocks.push([HEADER, ...RULES].join("\n"))，再 blocks.join("\n\n")
    const expected = [ANSWER_CURRENCY_HEADER, ...ANSWER_CURRENCY_RULES].join('\n')
      + '\n\n'
      + [ANSWER_PREFERENCE_HEADER, ...ANSWER_PREFERENCE_RULES].join('\n');
    expect(buildAnswerGuidance()).toBe(expected);
    expect(source).toContain('blocks.join("\\n\\n")');
  });

  itWithCanon(canonGuide, 'memory-tools-guide.ts')('三句反拒答纪律与单一源逐字一致（工具清单是显式 override）', () => {
    const source = canonGuide as string;
    for (const sentence of [
      '只要其中有与该问题相关的内容，就直接据此作答（必要时注明记忆时间），不要因为记忆不完整而拒答。',
      '请依据已注入的相关记忆作答并注明记录时间；只有已注入的记忆也完全没有相关线索时才说明无法确定，不要编造。',
    ]) {
      expect(MEMORY_TOOLS_GUIDE).toContain(sentence);
      expect(source).toContain(sentence);
    }
    expect(source).toContain(MEMORY_TOOLS_GUIDE_VERSION);
    // 差异必须是「工具面」而不是「纪律」：单一源有 tdai_*，dsh 侧只有 memory_recall
    expect(source).toContain('tdai_memory_search');
    expect(MEMORY_TOOLS_GUIDE).not.toContain('tdai_memory_search');
    expect(MEMORY_TOOLS_GUIDE).not.toBe(source);
  });
});

describe('guidance: 注入位置（system prompt section，不是 volatile user 消息）', () => {
  it('注册为独立 section：order 紧跟 head pack 之后、静态文本、fail-open', async () => {
    vi.stubGlobal('fetch', fetchMock);
    const fake = createFakeContext();
    await apply(fake.ctx, {});

    const guidance = fake.sections.find((section) => section.name === 'tdb-agemem:answer-guidance');
    expect(guidance).toBeDefined();
    expect(guidance?.order).toBe(10301); // 10200 + headPack.orderOffset(100) + 1
    expect(guidance?.interpolate).toBe(false);
    expect(guidance?.text).toBe(GUIDANCE_TEXT);
    // 渲染顺序由 order 决定（host 排序），与注册顺序无关；head pack 仍是最后注册的段。
    expect(fake.sections.map((section) => section.order).sort()).toEqual([10300, 10301]);
    expect(fake.sections[fake.sections.length - 1]?.name).toBe('tdb-agemem:head-pack');
  });

  it('head pack 不可达时口径照旧注入（不依赖取数成功）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }));
    const fake = createFakeContext();
    await expect(apply(fake.ctx, {})).resolves.toBeUndefined();
    const guidance = fake.sections.find((section) => section.name === 'tdb-agemem:answer-guidance');
    expect(guidance).toBeDefined();
    expect(String(guidance?.text)).toContain(ANSWER_CURRENCY_HEADER);
  });

  it('volatile 追加的 user 消息里没有口径段（系统级规范不落成用户输入历史）', async () => {
    vi.stubGlobal('fetch', fetchMock);
    const fake = createFakeContext();
    // 身份不再是缺省值：不配 identity 的插件是 inert 的，不会发检索请求。
    await apply(fake.ctx, { server: { teamId: 'team-test', agentId: 'agt-test', userId: 'usr-test' } });
    const listener = fake.firstListener('agent/pre-step');
    expect(listener).toBeDefined();

    const claimed = [userMessage('我的猫叫什么？')];
    const decision: any = await runPreStep(
      listener,
      { agent: { session: { id: 's1' } }, turn: 1, step: 1 },
      { kind: 'enter', messages: claimed },
    );
    const appended = (decision?.messages ?? []).filter((message: any) => message?.source?.kind !== 'user');
    expect(appended).toHaveLength(1);
    const appendedText = JSON.stringify(appended[0]);
    expect(appendedText).not.toContain(ANSWER_CURRENCY_HEADER);
    expect(appendedText).not.toContain('memory-tools-guide');
    expect(appendedText).not.toContain('币值判定');
  });
});
