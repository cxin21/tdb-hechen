import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 登录页的验收口径（DESIGN.md 的禁令对入口页同样成立）：
 *  1. 卡片是实底（不许毛玻璃），星场当背景；
 *  2. 没有全大写小标签、没有装饰性字距；
 *  3. 颜色只取 token，样式表不出现 16 进制字面量；
 *  4. 登录链路不许被重画改坏：实例列表 → verify → 写会话。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const components = path.resolve(here, '..');

function read(name: string): string {
  return fs.readFileSync(path.join(components, name), 'utf8');
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const GATE = read('LoginGate.tsx');
const CSS = stripComments(read('login-gate.css'));
const FIELD = read('LoginStarfield.tsx');

describe('登录页视觉', () => {
  it('卡片实底 + 星场当背景，不再是毛玻璃', () => {
    expect(GATE).toContain('starmap-root login-root');
    expect(GATE).toContain('LoginStarfield');
    expect(CSS).not.toMatch(/backdrop-filter/);
    expect(CSS).not.toMatch(/linear-gradient|radial-gradient/);
    // 旧实现是 tea-component；新实现只用 kit 组件与原生表单元素
    expect(stripComments(GATE)).not.toContain('tea-component');
    expect(stripComments(GATE)).not.toContain('ParticleWaveBackground');
  });

  it('没有全大写小标签与装饰性字距', () => {
    expect(CSS).not.toMatch(/text-transform/);
    expect(CSS).not.toMatch(/letter-spacing/);
  });

  it('颜色只取 token：样式表里没有 16 进制与半透明字面量', () => {
    const hex = CSS.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(hex).toEqual([]);
    expect(CSS).not.toMatch(/rgba?\(/);
  });

  it('星场背景是确定性的：没有随机数，位置只由画布尺寸决定', () => {
    expect(FIELD).toContain('makeDust');
    expect(stripComments(FIELD)).not.toContain('Math.random');
    expect(FIELD).toContain('2.399963229728653');
  });
});

describe('登录链路', () => {
  it('实例列表 → verify → 写会话，三步都在', () => {
    expect(GATE).toContain('metaInstancesApi');
    expect(GATE).toContain('authVerifyApi.verify');
    expect(GATE).toContain('setPanelSession');
    expect(GATE).toContain('resumeSession');
    expect(GATE).toContain('clearPanelSession');
  });

  it('键盘可用：表单是 <form onSubmit>，提交按钮是 submit 类型', () => {
    expect(GATE).toContain('<form onSubmit={submit}');
    expect(GATE).toMatch(/type="submit"/);
  });

  it('失败不假装成功：invalid / noUser / 异常三条分支都落到错误提示', () => {
    expect(GATE).toContain("t('login.error.invalidKey')");
    expect(GATE).toContain("t('login.error.noUser')");
    expect(GATE).toMatch(/setError\(err instanceof Error \? err\.message : String\(err\)\)/);
  });
});
