import { describe, expect, it } from 'vitest';
import {
  ASSET_REFLECTION_MARKER,
  ASSET_REFLECTION_MAX_CHARS,
  ASSET_REFLECTION_SECTION_NAME,
  DEFAULT_ASSET_REFLECTION_POLICY,
  DEFAULT_ASSET_REFLECTION_TOKEN,
  REFLECTION_CLOSE,
  REFLECTION_OPEN,
  hasTriggerToken,
  installAssetReflection,
  installAssetReflectionTrigger,
  registerAssetReflection,
  registerAssetReflectionSection,
  renderAssetReflectionBlock,
  resolveAssetReflectionPolicy,
  stripAssetReflection,
} from '../src/asset-reflection.js';
import { createFakeContext, runPreStep } from './helpers/fake-ctx.js';
import { assistantMessage, userMessage } from './helpers/messages.js';

const deps = {
  enabled: true,
  triggerToken: DEFAULT_ASSET_REFLECTION_TOKEN,
  alwaysOn: false,
  maxChars: 600,
};

function textOf(fake: ReturnType<typeof createFakeContext>): string {
  const section = fake.sections.find((entry) => entry.name === ASSET_REFLECTION_SECTION_NAME);
  if (!section) return '';
  return typeof section.text === 'function' ? section.text() : section.text;
}

/** The reflection hook is appended last on purpose (waterfall order). */
function lastPreStep(fake: ReturnType<typeof createFakeContext>) {
  const listener = fake.listeners.get('agent/pre-step')?.at(-1);
  if (!listener) throw new Error('asset-reflection pre-step listener not installed');
  return listener;
}

function step(listener: (...args: any[]) => unknown, messages: any[]) {
  return runPreStep(listener, { agent: { session: { id: 's1' } }, turn: 1, step: 1 }, { kind: 'enter', messages });
}

describe('asset reflection block', () => {
  it('renders the eval block with the open marker and only the assets DSH really has', () => {
    const block = renderAssetReflectionBlock(1200);
    expect(block.startsWith('<asset_reflection>')).toBe(true);
    expect(block.endsWith(REFLECTION_CLOSE)).toBe(true);
    expect(block).toContain(REFLECTION_OPEN);
    expect(block).toContain(ASSET_REFLECTION_MARKER);
    // DSH 侧真实资产：宿主 skill 工具 + 插件 memory_recall。
    expect(block).toContain('skill');
    expect(block).toContain('memory_recall');
    // proxy 的两个 tag 在本侧根本不存在，照抄会指错工具。
    expect(block).not.toContain('<skill_tools>');
    expect(block).not.toContain('<tdai_memory_tools>');
  });

  it('clips to maxChars without leaving a half-open tag', () => {
    const budget = 260;
    const block = renderAssetReflectionBlock(budget);
    expect(block.length).toBeLessThanOrEqual(budget);
    expect(block.startsWith('<asset_reflection>')).toBe(true);
    expect(block.endsWith(REFLECTION_CLOSE)).toBe(true);
    // 裁到整行：闭合标签前不出现被切成两半的内容行
    expect(block).toContain(REFLECTION_OPEN);
  });
});

describe('asset reflection trigger token', () => {
  it('only matches the token as a standalone word', () => {
    for (const text of ['/analyse', '请 /analyse 这轮', '/analyse\n继续', '（/analyse）']) {
      expect(hasTriggerToken(text, '/analyse')).toBe(true);
    }
    for (const text of ['', '/analysed', '/analyse-x', 'a/analyse', '/analyse2']) {
      expect(hasTriggerToken(text, '/analyse')).toBe(false);
    }
  });

  it('resolves the policy defensively: missing config, dirty values, direct section shape', () => {
    expect(resolveAssetReflectionPolicy(undefined)).toEqual(DEFAULT_ASSET_REFLECTION_POLICY);
    expect(resolveAssetReflectionPolicy({ assetReflection: { triggerToken: '   ', maxChars: 99999, alwaysOn: 'yes' } })).toEqual({
      enabled: true,
      triggerToken: DEFAULT_ASSET_REFLECTION_TOKEN,
      alwaysOn: false,
      maxChars: ASSET_REFLECTION_MAX_CHARS,
    });
    // 独立 harness 也可以直接传段本身
    expect(resolveAssetReflectionPolicy({ triggerToken: '/reflect', maxChars: 5, enabled: false })).toEqual({
      enabled: false,
      triggerToken: '/reflect',
      alwaysOn: false,
      maxChars: 120,
    });
  });
});

describe('asset reflection section and turn scope', () => {
  it('registers an inert section (empty text, own order, no interpolation)', () => {
    const fake = createFakeContext();
    const handle = registerAssetReflectionSection(fake.ctx, deps);
    const section = fake.sections.find((entry) => entry.name === ASSET_REFLECTION_SECTION_NAME);
    expect(section).toBeDefined();
    expect(section?.order).toBe(10302); // 10200 + 102 (after head pack +100, guidance +101)
    expect(section?.interpolate).toBe(false);
    expect(handle.active()).toBe(false);
    expect(textOf(fake)).toBe('');
    handle.set(true);
    expect(textOf(fake)).toContain(REFLECTION_OPEN);
    handle.dispose();
    expect(fake.sections).toHaveLength(0);
  });

  it('injects on the token turn and disappears on the next turn', async () => {
    const fake = createFakeContext();
    installAssetReflection(fake.ctx, { ...deps, log: fake.ctx.logger });
    const listener = lastPreStep(fake);

    await step(listener, [userMessage('请 /analyse 这轮的记忆效果')]);
    expect(textOf(fake)).toContain(REFLECTION_OPEN);

    await step(listener, [userMessage('普通问题')]);
    expect(textOf(fake)).toBe('');
  });

  it('injects on every turn when alwaysOn is set (eval sessions)', async () => {
    const fake = createFakeContext();
    installAssetReflection(fake.ctx, { ...deps, alwaysOn: true, log: fake.ctx.logger });
    await step(lastPreStep(fake), [userMessage('普通问题')]);
    expect(textOf(fake)).toContain(REFLECTION_OPEN);
  });

  it('keeps the decision for later steps of the same turn (no new user text claimed)', async () => {
    const fake = createFakeContext();
    installAssetReflection(fake.ctx, { ...deps, log: fake.ctx.logger });
    const listener = lastPreStep(fake);
    await step(listener, [userMessage('/analyse')]);
    expect(textOf(fake)).toContain(REFLECTION_OPEN);
    // 同一轮的工具调用 step：认领不到新的用户消息，标志必须保留而不是被清掉
    await step(listener, [assistantMessage('mid-turn tool step')]);
    expect(textOf(fake)).toContain(REFLECTION_OPEN);
  });

  it('does nothing when disabled, and the one-liner wiring tears down cleanly', () => {
    const off = createFakeContext();
    registerAssetReflection(off.ctx, { assetReflection: { enabled: false } }, off.ctx.logger);
    expect(off.sections).toHaveLength(0);
    expect(off.listenerCount('agent/pre-step')).toBe(0);

    const on = createFakeContext();
    const dispose = registerAssetReflection(on.ctx, undefined, on.ctx.logger);
    expect(on.sections).toHaveLength(1);
    expect(on.listenerCount('agent/pre-step')).toBe(1);
    dispose();
    expect(on.sections).toHaveLength(0);
    expect(on.listenerCount('agent/pre-step')).toBe(0);
  });

  it('fail-open: a throwing host section registration leaves the turn untouched', () => {
    const fake = createFakeContext();
    fake.ctx.systemPrompt.section = () => {
      throw new Error('host refused');
    };
    const handle = registerAssetReflectionSection(fake.ctx, { ...deps, log: fake.ctx.logger });
    expect(handle.active()).toBe(false);
    expect(fake.sections).toHaveLength(0);
    expect(fake.logs.some((line) => line.includes('asset-reflection section registration failed'))).toBe(true);
  });
});

describe('asset reflection stripping (L0 hygiene)', () => {
  it('returns plain answers untouched', () => {
    expect(stripAssetReflection('部署用 pnpm。')).toBe('部署用 pnpm。');
    expect(stripAssetReflection('')).toBe('');
  });

  it('cuts the reflection block and the separator left behind', () => {
    const answer = ['部署用 pnpm。', '', '---', '', REFLECTION_OPEN, '- skill::tdd：没命中'].join('\n');
    expect(stripAssetReflection(answer)).toBe('部署用 pnpm。');
  });

  it('returns an empty string when the message is only the reflection', () => {
    expect(stripAssetReflection([REFLECTION_OPEN, '- memory_recall::部署：有用'].join('\n'))).toBe('');
  });
});
