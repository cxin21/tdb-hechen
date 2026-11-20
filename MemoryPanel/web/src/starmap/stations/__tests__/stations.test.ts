/**
 * 团队站 / 设置站的契约测试。
 *
 * 这两站原来是把旧组件（TeamManagementPanel、ApiKeysPage、SettingsPage）整块嵌进新壳，
 * 于是「新壳」里还留着卡片套卡片、全大写英文标签和旧的写路径。这里锁住三件事：
 *   1. 不再 import 旧页面/旧面板；
 *   2. 写操作只走 lib/api 的原生端点，且危险动作是两段式（先问再删）；
 *   3. 设置站是只读的——出现 set / revectorize 就是有人偷偷加了写入口。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const team = read('../TeamStation.tsx');
const settings = read('../SettingsStation.tsx');
const memory = read('../MemoryStation.tsx');
const knowledge = read('../KnowledgeStation.tsx');
const skills = read('../SkillsStation.tsx');

describe('团队站：原生实现', () => {
  it('不再嵌入旧团队面板与旧密钥页', () => {
    expect(team).not.toContain("components/team/TeamManagementPanel");
    expect(team).not.toContain("pages/ApiKeysPage");
    expect(team).not.toContain('st-embed');
  });

  it('成员 / 智能体 / 密钥都走 lib/api 的原生端点', () => {
    for (const name of ['membersApi.list', 'membersApi.add', 'membersApi.remove']) {
      expect(team).toContain(name);
    }
    for (const name of ['agentsApi.list', 'agentsApi.create', 'agentsApi.update', 'agentsApi.delete']) {
      expect(team).toContain(name);
    }
    for (const name of ['userKeysApi.list', 'userKeysApi.create', 'userKeysApi.revoke']) {
      expect(team).toContain(name);
    }
  });

  it('删除与吊销是两段式：先出「确认…」，点了才真调', () => {
    expect(team).toContain('确认移除');
    expect(team).toContain('确认删除');
    expect(team).toContain('确认吊销');
    // 确认分支才调用写接口：确认按钮的 onClick 与写函数在同一分支里
    expect(team).toMatch(/confirmDelete === a\.agent_id[\s\S]{0,400}void remove\(a\.agent_id\)/);
    expect(team).toMatch(/confirmRevoke === k\.key_id[\s\S]{0,400}void revoke\(k\.key_id\)/);
  });

  it('明文密钥只展示一次，并明说要用户自己保存', () => {
    expect(team).toContain('新密钥（只显示这一次）');
    expect(team).toContain('关闭或离开本页后无法再次查看');
    expect(team).toContain('key_value');
  });

  it('不改角色（后端没有改角色端点，就不做假 UI）', () => {
    expect(team).toContain('后端当前没有改角色的端点');
    expect(team).not.toMatch(/membersApi\.update/);
  });

  it('深操作如实指路旧控制台，而不是在站内做半成品', () => {
    expect(team).toContain('资产分配 / 人格草稿 → 旧控制台');
    expect(team).toContain("nav('/legacy' + path)");
  });

  it('行内按钮不与整行点击叠成按钮套按钮', () => {
    expect(team).not.toMatch(/onClick=\{canWrite\(a\) \? \(\) => setEditing\(a\)/);
  });
});

describe('设置站：只读概览', () => {
  it('不再嵌入旧设置页', () => {
    expect(settings).not.toContain("pages/SettingsPage");
    expect(settings).not.toContain('st-embed');
  });

  it('只读：没有任何写入口', () => {
    expect(settings).not.toContain('settingsApi.set');
    expect(settings).not.toContain('revectorize');
    expect(settings).not.toContain('rerankModelApi.download');
  });

  it('两个服务与本地重排模型都读到生效值', () => {
    expect(settings).toContain('settingsApi.get');
    expect(settings).toContain('<ViewPanel target="knowledge" />');
    expect(settings).toContain('<ViewPanel target="memory" />');
    expect(settings).toContain('rerankModelApi.status');
  });

  it('非管理员看不到配置，只看到角色说明', () => {
    expect(settings).toContain('设置页需要全局管理员');
    expect(settings).toMatch(/isAdmin \? \(/);
  });

  it('编辑入口指向旧控制台并说明原因', () => {
    expect(settings).toContain("nav('/legacy/settings')");
    expect(settings).toContain('逐项对齐前不照抄第二遍');
  });
});
describe('点亮 / 熄灭：站内能改「挂到本 agent」', () => {
  it('记忆块用 chat-memory 的 allocate/unbind，不是自己拼写请求', () => {
    expect(memory).toContain('chatMemoryApi.allocate(');
    expect(memory).toContain('chatMemoryApi.unbind(');
    expect(memory).not.toContain("'/allocate'");
    expect(memory).not.toContain('fetch(');
  });

  it('记忆块按 block.agent_id 判定当前状态，按钮文案成对出现', () => {
    expect(memory).toContain('block.agent_id === sm.activeAgentId');
    expect(memory).toContain('挂到当前智能体');
    expect(memory).toContain('从当前智能体移除');
  });

  it('wiki / code 资产用 knowledgeApi 的 allocate/unbind，且按 asset_type 分开取挂载表', () => {
    expect(knowledge).toContain('knowledgeApi.wiki.allocate(');
    expect(knowledge).toContain('knowledgeApi.wiki.unbind(');
    expect(knowledge).toContain('knowledgeApi.code.allocate(');
    expect(knowledge).toContain('knowledgeApi.code.unbind(');
    expect(knowledge).toContain('knowledgeApi.agentFixed(');
    expect(knowledge).toContain("k.asset_type === (kind === 'wiki' ? 'llm_wiki' : 'code_graph')");
  });

  it('没有选中 agent 时挂载按钮缺席，并说明原因（不发必然失败的请求）', () => {
    expect(memory).toContain('先在上方选一个智能体');
    expect(knowledge).toContain('先选一个智能体，资产才能挂载');
    expect(memory).toMatch(/sm\.teamId && sm\.activeAgentId \?/);
    expect(knowledge).toMatch(/sm\.activeAgentId \? \(/);
  });
});
describe('技能站：挂载＝fork，移除＝归档副本，删源件单独一条路', () => {
  it('不再嵌旧技能页，也不再用旧卡片壳', () => {
    expect(skills).not.toContain("pages/SkillsPage");
    expect(skills).not.toContain('st-memcard');
    expect(skills).not.toContain('<Card2');
  });

  it('挂载走 skillApi.forkToAgent，移除走 deleteSkillV3 并按真实 owner 传 agent 轴', () => {
    expect(skills).toContain('skillApi.forkToAgent(sm.teamId, s.skill_id, sm.activeAgentId)');
    expect(skills).toContain('agent_id: s.owner_agent_id || sm.activeAgentId');
    expect(skills).toContain('expected_version: s.version');
  });

  it('两个危险动作都是两段式：确认分支里才调写接口', () => {
    expect(skills).toContain('确认移除');
    expect(skills).toContain('确认删除源件');
    expect(skills).toMatch(/confirmDetach === detail\.skill_id[\s\S]{0,600}void toggleMount\(detail\)/);
    expect(skills).toMatch(/confirmDelete === detail\.skill_id[\s\S]{0,600}void removeSource\(detail\)/);
  });

  it('有 owner 副本时只给「移除」，不给并列的「删除源件」（同一 id 两个按钮＝误点）', () => {
    expect(skills).toContain('{detail.owner_agent_id ? null : confirmDelete === detail.skill_id ? (');
  });

  it('没有选中 agent 时不发必然失败的请求，改说明原因', () => {
    expect(skills).toContain('先选一个智能体，技能才能挂接');
    expect(skills).toContain('没有登录用户，无法按 v3 契约改动技能归属。');
  });
});
