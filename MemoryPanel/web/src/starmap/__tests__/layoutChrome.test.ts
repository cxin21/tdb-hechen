import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 星图层不许再出现旧控制台的 chrome 类名（rowitem / sm-btn / sm-link / st-field）。
 * 这些类留一个就说明某个面还没搬完，而且它们自带填充块与 9px 大写小标签，
 * 与 DESIGN.md 的选中态语言（文字转实色 + 2px 层色短线）直接冲突。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const starmapRoot = path.resolve(here, '..');
const layoutPath = path.join(starmapRoot, 'StarmapLayout.tsx');
const cssPath = path.join(starmapRoot, 'theme', 'tokens.css');

function stripComments(src: string) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      if (name === '__tests__' || name === '__preview__') continue;
      walk(full, out);
    } else if (/\.(tsx|ts)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const OLD_CLASSES = ['rowitem', 'sm-btn', 'sm-link', '"st-field"'];

describe('星图层没有旧 chrome 类名', () => {
  const files = walk(starmapRoot);

  it('扫到的文件足够多（防止 walk 走空导致假绿）', () => {
    expect(files.length).toBeGreaterThan(25);
  });

  it('任何 tsx/ts 里都不再出现 rowitem / sm-btn / sm-link / st-field', () => {
    const hits: string[] = [];
    for (const file of files) {
      const src = stripComments(fs.readFileSync(file, 'utf8'));
      for (const key of OLD_CLASSES) {
        if (src.includes(key)) hits.push(path.relative(starmapRoot, file) + ' -> ' + key);
      }
    }
    expect(hits).toEqual([]);
  });

  it('tokens.css 里对应的规则也删干净了', () => {
    const css = stripComments(fs.readFileSync(cssPath, 'utf8'));
    for (const sel of ['.sm-btn', '.rowitem', '.sm-link']) {
      expect(css.includes(sel)).toBe(false);
    }
  });

  it('星门列表用 kit Row，团队弹窗用 kit Dialog', () => {
    const src = stripComments(fs.readFileSync(layoutPath, 'utf8'));
    expect(src).toContain("from './kit'");
    expect(src).toContain('<Row');
    expect(src).toContain('<Dialog');
    expect(src).not.toContain('station-veil" data-testid="team-dialog"');
  });

  it('团队弹窗的字段与动作走 kit 类名', () => {
    const src = fs.readFileSync(layoutPath, 'utf8');
    expect(src).toContain('className="st-input"');
    expect(src).toContain('className="stk-btn is-ghost is-sm"');
  });
});
