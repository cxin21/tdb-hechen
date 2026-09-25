import { describe, it, expect } from 'vitest';
import { mergeStrictRuleContent } from './pending-adopt-merge.js';

const E3 = '- 绝不派发子代理执行开发任务：AI 必须亲自完成编码与测试验证（因子代理产出质量问题）。\n- 公开仓库绝不容许密钥与私有资产入库：真实密钥配置、runs/ 评估证据、内网地址等必须 gitignore，推送前须做密钥检查。\n- tdai 仓库采用部署即仓库模式：变更直接在 main 工作区实施、不开 worktree（用户批准的既定先例）。';

describe('V12-ADJ：pending 采纳合并语义（修复整槽替换丢既有红线 P0 缺陷）', () => {
  it('既有 3 行全部保留 + 采纳行追加为第 4 行（P0 缺陷回归：原实现仅剩 adopted 单行）', () => {
    const merged = mergeStrictRuleContent(E3, '必须遵守 TDB 项目部署与开发中实测沉淀的环境铁律（违反即停工）。');
    const lines = merged.split('\n');
    expect(lines.length).toBe(4);
    expect(lines[0]).toContain('绝不派发子代理');
    expect(lines[2]).toContain('部署即仓库');
    expect(lines[3]).toContain('环境铁律');
    expect(lines[3].startsWith('- ')).toBe(true);
  });
  it('采纳行与既有行逐字重复 → 不重复追加（幂等）', () => {
    const merged = mergeStrictRuleContent(E3, '绝不派发子代理执行开发任务：AI 必须亲自完成编码与测试验证（因子代理产出质量问题）。');
    expect(merged.split('\n').length).toBe(3);
  });
  it('existing 空/undefined → 仅采纳单行（首次采纳）', () => {
    expect(mergeStrictRuleContent(undefined, '红线甲')).toBe('- 红线甲');
    expect(mergeStrictRuleContent('', '红线甲')).toBe('- 红线甲');
  });
  it('既有行缺 - 前缀 → 规范化补齐（格式统一）', () => {
    const merged = mergeStrictRuleContent('裸行规则甲\n- 裸行规则乙', '红线丙');
    const lines = merged.split('\n');
    expect(lines.length).toBe(3);
    expect(lines.every(l => l.startsWith('- '))).toBe(true);
  });
});
