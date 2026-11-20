import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const KIT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

function kitFiles(ext: string): string[] {
  return readdirSync(KIT_DIR)
    .filter((f) => f.endsWith(ext))
    .map((f) => join(KIT_DIR, f));
}

/** 去掉注释再扫：文件头注释里点名了这些禁令，不剥掉会把注释本身当成违规。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

/**
 * 视觉禁令的机器检查。这些规则在 DESIGN.md 里是散文，散文拦不住回归，
 * 所以落成断言：改坏了这条测试必须变红（不是靠人记得）。
 */
describe('kit 视觉禁令', () => {
  const css = stripComments(read(join(KIT_DIR, 'kit.css')));

  it('样式文件不出现 16 进制颜色（颜色只能来自 token）', () => {
    const hits = css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(hits).toEqual([]);
  });

  it('不出现 backdrop-filter / 渐变 / 模糊（卡片不许当玻璃）', () => {
    expect(css).not.toMatch(/backdrop-filter/);
    expect(css).not.toMatch(/linear-gradient|radial-gradient/);
    expect(css).not.toMatch(/filter:\s*blur/);
  });

  // 面板必须是实底：半透明底色叠在星场上会让星点在字上爬（视觉复核被读成「毛玻璃」多次）。
  it('不出现半透明颜色（rgba/hsla）——面板底不能透星', () => {
    expect(css).not.toMatch(/rgba\(|hsla\(/);
    // 面板底色必须是实色 token，不是 transparent / 半透明叠层
    expect(css).toMatch(/\.stk-surface\s*\{[^}]*background:\s*var\(--surface\)/);
  });

  it('不出现全大写小标签与装饰性字距', () => {
    expect(css).not.toMatch(/text-transform/);
  });

  it('不出现 transition: all（会放大到布局属性上）', () => {
    expect(css).not.toMatch(/transition:\s*all/);
  });

  it('box-shadow 只允许 inset（禁止外发光）', () => {
    const decls = css.match(/box-shadow:\s*([^;]+);/g) ?? [];
    for (const d of decls) {
      expect(d).toMatch(/box-shadow:\s*inset/);
    }
  });

  it('每条动效都落在 --ease-out 或极短时长内', () => {
    const durations = css.match(/transition:[^;]+;/g) ?? [];
    for (const d of durations) {
      expect(d).toMatch(/(1[0-5]\d|\d\d)ms/);
      expect(d).toMatch(/var\(--ease-out\)/);
    }
  });

  it('组件源码不写死颜色，也不自带样式字符串以外的样式表', () => {
    for (const p of [...kitFiles('.tsx'), ...kitFiles('.ts')]) {
      const src = stripComments(read(p));
      expect(src, p).not.toMatch(/#[0-9a-fA-F]{6}/);
      expect(src, p).not.toMatch(/backdrop-filter|text-transform:\s*uppercase/);
    }
  });
});
