import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * r26e-a1 的反证缺口：判据函数本身有测试（session-identity.test.ts 的 cardClearedSource 组），
 * 但「index.ts 到底有没有把它传下去」没有测试——删掉 trackBind 的第三参时 83 条 index 用例全绿。
 * 这条守卫直接读源码，只钉接线形状，不重复判据逻辑。
 */
const SRC = readFileSync(path.join(process.cwd(), 'src', 'index.ts'), 'utf8');

describe('清卡归因接线（r26e-a1）', () => {
  it('三个清卡入口都传 cardClearedSource，而不是内联三元', () => {
    // 两个清卡入口各一处（import 行不带括号，别数进来）。
    expect(SRC).toContain('cardClearedSource(bound)');
    expect(SRC).toContain('cardClearedSource(binding)');
    // 旧写法（「有绑定才算拒绝，否则 undefined」）会把配置缺口记成无归因。
    expect(SRC).not.toContain('bound === undefined ? undefined : declined');
  });

  it('restored 分支在身份为空时也带 unconfigured', () => {
    expect(SRC).toContain("restoredIdentity === undefined ? 'unconfigured' : undefined");
  });
});
