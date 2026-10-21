import { describe, it, expect } from 'vitest';
import { mergeStrictRuleContent, sanitizeDescription } from './pending-adopt-merge.js';
import { REDLINE_MERGE_THRESHOLD, proposalSimilarity } from '../core/lifecycle/proposal-dedup.js';

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

// ═══════════════ v18-d · sanitizeDescription 悬空尾判定单一源（isDanglingTail 复用） ═══════════════

describe('v18-d：sanitizeDescription 悬空尾（写入口挡断尾半句入库）', () => {
  it('尾悬空标点 → 置空；无句读短语（含 17 字生产样本）保留（低置信不判）', () => {
    expect(sanitizeDescription('证据裁决一切，', 60)).toBe('');
    expect(sanitizeDescription('所有结论须以真实代码与测试取证背书', 60)).toBe('所有结论须以真实代码与测试取证背书');
    expect(sanitizeDescription('保持审慎', 60)).toBe('保持审慎');
  });

  it('窗口内有句末标点 → 截到最后句末标点（既有语义不回归）；超长截断无句读 → 置空', () => {
    expect(sanitizeDescription('证据裁决一切。拒绝粉饰，', 60)).toBe('证据裁决一切。');
    expect(sanitizeDescription('这是一段完全没有标点的长文本流用于验证写入口截断置空门判定行为是否正确' + 'xxxxxxxxxx'.repeat(6), 60)).toBe('');
  });
});

// ═══════════════ P3 #80 · mergeStrictRuleContent 相似合并（增量生成：相似→更新而非新增） ═══════════════

// 夹具=生产 strict_rule 槽真实行快照（硬编码字面量，测试不触生产库）。
const R1 = '排查期间绝不可通过任何路径删除记忆（P1红线），也绝不可注入测试对话，以免测试数据永久污染l1_records。';
const R2 = '无论排查还是运维操作，绝不可通过任何路径删除记忆（P1红线），也绝不可注入测试对话或测试数据（零删除、零注入），以免测试数据永久污染记忆库。';
const R4 = '无依据不擅为：缺必填参数先问明再回填重试、不编造；脚本侧无证据不调LLM；AI全程禁自行git commit（controller review后统一conventional commit）；整文件手术用edit工具、禁pwsh Set-Content。';
const R10 = '无依据不擅为：缺必填参数先问明再回填重试、不编造；脚本侧无证据不调LLM；AI 全程零自行 commit/push，须用户明确开口授权，执行前只读盘点+diff 纯净核查、surgical 最小范围提交、绝不裹挟外来 WIP；整文件手术用edit工具、禁pwsh Set-Content。';
const NC_A = 'NC 客开边界约定：模块归属以单据域为准——pu 服务采购域（poorder/到货），purp 服务询报价域（askbill/供应商价目表），接口与 action 随所属单据域放置，不同单据的校验逻辑不得混用。';
const NC_B = 'NC 客开红线：action 层绝不直查数据库（不 new BaseDAO()），需要查询一律新增下沉服务接口（pubitf/impl 配对）并遵守新增接口规范。';

describe('P3 #80：mergeStrictRuleContent 相似合并（增量生成：相似→更新而非新增）', () => {
  it('阈值常量=0.4；真实重复对相似度高于阈值、无关对低于阈值（标定自证）', () => {
    expect(REDLINE_MERGE_THRESHOLD).toBe(0.4);
    expect(proposalSimilarity(R1, R2)).toBeGreaterThan(REDLINE_MERGE_THRESHOLD);
    expect(proposalSimilarity(R4, R10)).toBeGreaterThan(REDLINE_MERGE_THRESHOLD);
    expect(proposalSimilarity(NC_A, NC_B)).toBeLessThan(REDLINE_MERGE_THRESHOLD);
  });

  it('采纳行与既有行相似且更长（R1→R2）→ 原位替换（更新非新增），短变体消失', () => {
    const merged = mergeStrictRuleContent('- ' + R1, R2);
    const lines = merged.split('\n');
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('运维操作');
    expect(lines[0].startsWith('- ')).toBe(true);
  });

  it('反向：采纳行更短（R1 vs 既有 R2）→ 旧行保留、采纳行丢弃（宁保守不降信息量）', () => {
    const merged = mergeStrictRuleContent('- ' + R2, R1);
    expect(merged.split('\n').length).toBe(1);
    expect(merged).toContain('运维操作');
  });

  it('L4×L10 同规则双变体 → 合并保留 L10（授权链信息更全）', () => {
    const merged = mergeStrictRuleContent('- ' + R4, R10);
    expect(merged.split('\n').length).toBe(1);
    expect(merged).toContain('用户明确开口授权');
  });

  it('全等幂等优先于相似合并（既有语义零回归）', () => {
    const merged = mergeStrictRuleContent('- ' + R2 + '\n- 独立红线', R2);
    expect(merged.split('\n').length).toBe(2);
  });

  it('低相似对（NC_A×NC_B）→ 不合并照常追加（阈值安全边距）', () => {
    const merged = mergeStrictRuleContent('- ' + NC_A, NC_B);
    expect(merged.split('\n').length).toBe(2);
  });

  it('多行既有中间行被替换 → 原位保序（非尾部追加）', () => {
    const merged = mergeStrictRuleContent('- 甲红线\n- ' + R1 + '\n- 乙红线', R2);
    const lines = merged.split('\n');
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain('甲红线');
    expect(lines[1]).toContain('运维操作');
    expect(lines[2]).toContain('乙红线');
  });

  it('与既有不相似 → 追加路径保持（V12-ADJ 语义零回归）', () => {
    const merged = mergeStrictRuleContent('- ' + NC_A, '全新独立红线丁');
    expect(merged.split('\n').length).toBe(2);
  });
});
