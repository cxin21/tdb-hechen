import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 云名只有一套：记忆星云 / 典籍星云 / 构筑星云 / 技艺星云。
 * 画布、星门、云页侧卡三处必须逐字一致——写「忆云」写「记忆星云」会被读成两个地方。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const OWNER_FILES = [
  'StarmapLayout.tsx',
  'scene/FiveBodies.tsx',
  'scene/CloudSideCard.tsx',
  'scene/layout.ts',
];

const CANON = ['记忆星云', '典籍星云', '构筑星云', '技艺星云'];
const LEGACY = ["'忆云'", "'典籍云'", "'构筑云'", "'技艺云'"];

function stripComments(src: string) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

describe('云名口径一致', () => {
  it('三个所属文件里四个云名都出现，且没有旧短名字面量', () => {
    for (const rel of OWNER_FILES) {
      const src = stripComments(fs.readFileSync(path.join(root, rel), 'utf8'));
      for (const name of CANON) {
        expect(src.includes(name), rel + ' 缺少 ' + name).toBe(true);
      }
      for (const old of LEGACY) {
        expect(src.includes(old), rel + ' 仍在渲染旧名 ' + old).toBe(false);
      }
    }
  });

  it('星门的云名与云页侧卡一致（同一张表的两份拷贝不许分叉）', () => {
    const layout = stripComments(fs.readFileSync(path.join(root, 'StarmapLayout.tsx'), 'utf8'));
    const card = stripComments(fs.readFileSync(path.join(root, 'scene/CloudSideCard.tsx'), 'utf8'));
    for (const key of ['memory', 'wiki', 'code', 'skills']) {
      const re = new RegExp(key + ": '([^']+)'");
      const a = layout.match(re)?.[1];
      const b = card.match(re)?.[1];
      expect(a, 'StarmapLayout 缺 ' + key).toBeTruthy();
      expect(a).toBe(b);
    }
  });
});
