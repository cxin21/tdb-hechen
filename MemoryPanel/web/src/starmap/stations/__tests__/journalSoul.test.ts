import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 记忆站「回放日志」与人格站「感受 / 身份」的源码契约。
 *
 * 为什么用源码断言而不是渲染断言：这几块的价值全在「数据怎么取、口径怎么说」，
 * 而 node 环境没有 DOM 也没有假接口；组件渲染断言只能证明结构，证明不了「没伪造」。
 * 所以这里锁三件事：取数走缓存层、口径字段名对得上、旧页没有被重新嵌进来。
 */
/**
 * 读源码前先剥注释：文件头注释里会点名「旧页 RecallJournalView 一份没搬」这类原话，
 * 不剥就会把说明文字当成违规证据（kit.css 的禁令测试踩过同一个坑）。
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\n)\s*\/\/[^\n]*/g, '$1');
const read = (rel: string) =>
  stripComments(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8'));

describe('记忆站 · 回放日志（旧 ChatMemoryPage 第三档）', () => {
  const journal = read('../recallJournal.tsx');
  const station = read('../MemoryStation.tsx');

  it('走缓存层的 fetchRecallJournal，不再自己调 chatMemoryApi.recallJournal', () => {
    expect(journal).toContain("fetchRecallJournal");
    // 不能套 useResource：fetchRecallJournal 内部已排过一次 read 泳道，外层会白占槽位
    expect(journal).toContain('useApiResource(');
    expect(journal).not.toMatch(/useResource[<(]/);
    expect(journal).not.toContain('chatMemoryApi.recallJournal');
    // 旧组件不是搬到新壳，而是按同一份语义重画
    expect(journal).not.toContain('RecallJournalView');
    expect(journal).not.toContain('recall-journal.css');
  });

  it('三口径过滤连条数一起显示，skip 行标题退到 rawQuery', () => {
    expect(journal).toContain("type Filter = 'recall' | 'skipped' | 'all'");
    expect(journal).toContain('counts.recall');
    expect(journal).toContain('counts.skipped');
    expect(journal).toContain('rawQuery');
    expect(journal).toContain('skipReason');
  });

  it('缺团队 / 缺 agent 时明说缺哪一样，不发注定失败的请求', () => {
    expect(journal).toContain('先在上方选一个团队');
    expect(journal).toContain('先在上方选一个智能体');
    expect(journal).toMatch(/if \(!teamId\) \{[\s\S]{0,400}return \(/);
    expect(journal).toMatch(/if \(!agentId\) \{[\s\S]{0,400}return \(/);
  });

  it('记忆站有两档（记忆块 / 回放日志），回放档才挂日志面板', () => {
    expect(station).toContain("type ViewKey = 'blocks' | 'journal'");
    expect(station).toContain('回放日志');
    expect(station).toContain("import RecallJournalPanel from './recallJournal'");
    expect(station).toMatch(/view === 'journal' \? \(\s*<RecallJournalPanel/);
  });
});

describe('人格站 · 感受与身份（旧 SoulPage 前两档）', () => {
  const soul = read('../SoulStation.tsx');

  it('感受读 mood，不把 tier=null 说成中性', () => {
    expect(soul).toContain('chatMemoryApi.moodRead');
    expect(soul).toContain('MOOD_LABEL');
    expect(soul).toContain('近期没有可判定的基调');
    expect(soul).toContain('不补 0');
    // 基调 label 只描述近况，不做情绪诊断
    expect(soul).toContain('近期基调偏正面');
    expect(soul).toContain('近期基调偏紧绷');
  });

  it('身份按叙事三态处理：生效 / 条目形态 / 空', () => {
    expect(soul).toContain("format: 'narrative'");
    expect(soul).toContain('narrativePreviewOf');
    expect(soul).toContain("identity.state === 'active'");
    expect(soul).toContain("identity.state === 'empty'");
    expect(soul).toContain('条目形态');
    expect(soul).toContain('叙事生效');
  });

  it('身份双槽沿用旧页两栏语义与折叠阈值', () => {
    expect(soul).toContain('我是谁');
    expect(soul).toContain('我心中的他');
    expect(soul).toContain('self_identity');
    expect(soul).toContain('lines.length > 12');
    expect(soul).toContain('展开全文');
  });

  it('两块都在「完整视图」的分区里，且按记忆块取数', () => {
    expect(soul).toContain("feeling: '感受'");
    expect(soul).toContain("identity: '身份'");
    expect(soul).toContain("cacheKey('persona.feeling'");
    expect(soul).toContain("cacheKey('persona.identity'");
    expect(soul).toContain('没有选中记忆块');
  });
});