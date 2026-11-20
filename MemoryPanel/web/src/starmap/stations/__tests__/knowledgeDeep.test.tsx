import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WikiRawPanel, WikiSourcePanel } from '../knowledgeDeep';

/** 读被测源码：node 环境（无 jsdom）跑不了交互，只能用「端点调用 + 文案契约」当护栏。 */
const deepSrc = () =>
  readFileSync(fileURLToPath(new URL('../knowledgeDeep.tsx', import.meta.url)), 'utf8');
const stationSrc = () =>
  readFileSync(fileURLToPath(new URL('../KnowledgeStation.tsx', import.meta.url)), 'utf8');
const graphCanvasSrc = () =>
  readFileSync(fileURLToPath(new URL('../../scene/RelGraphCanvas.tsx', import.meta.url)), 'utf8');
const kitSrc = () =>
  readFileSync(fileURLToPath(new URL('../../kit/kit.css', import.meta.url)), 'utf8');
/** 断言前先剥注释：这些文件头注释里会点名禁用词，直接扫全文会误判。 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

const detail = {
  wiki_id: 'w-1',
  team_id: 'team-1',
  name: '交付文档库',
  service_url: null,
  source_type: 'git',
  source_url: 'git@host:td/docs.git',
  branch: 'main',
  path_include: 'docs/**.md',
  path_exclude: null,
  enabled: true,
  stale: true,
  summary: null,
  status: 'ready',
  internal_status: null,
  sync_error: null,
  version: '1',
  owner_user_id: 'u-1',
  page_count: 217,
  last_sync_at: '2026-11-11T04:00:00Z',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-11-11T04:00:00Z',
} as never;

describe('知识库深操作面（P7）', () => {
  it('来源面板给出四个真实动作，并把源口径摆出来', () => {
    const out = html(createElement(WikiSourcePanel, { detail, onChanged: () => undefined }));
    for (const t of ['测试连接', '保存源', '重新拉取', '编译', '源开关', '待重拉', 'docs/**.md']) {
      expect(out).toContain(t);
    }
  });

  it('面板不含旧件类名与全大写英文标签', () => {
    const out = html(createElement(WikiSourcePanel, { detail, onChanged: () => undefined }));
    expect(out).not.toContain('card2');
    expect(out).not.toContain('sm-btn');
    // 大写英文小标签（SOURCE / NEW / ASSET 这类）一律不该再出现
    expect(out).not.toMatch(/>\s*[A-Z][A-Z ]{2,}\s*</);
  });

  it('同一次渲染不产生重复的键值（源开关 与 值 不能撞字）', () => {
    const out = html(createElement(WikiSourcePanel, { detail, onChanged: () => undefined }));
    expect(out).toContain('源开关');
    expect(out).toMatch(/源开关<\/dt><dd[^>]*>开启/);
  });
});

describe('wiki 原始文档与页面删除（P7 补齐）', () => {
  it('原始文档面板首屏给出四件事：数量、刷新、上传、正文入口', () => {
    const out = html(createElement(WikiRawPanel, { wikiId: 'w-1', teamId: 'team-1' }));
    for (const t of ['读取中', '刷新', '上传原始文档', '文件名', '文档正文']) {
      expect(out).toContain(t);
    }
    // 首屏是加载态，不该装作已经读到文件
    expect(out).toContain('stk-skeleton');
  });

  it('四个 raw / page 端点都被真的调用了（不是只画了按钮）', () => {
    const src = deepSrc();
    for (const call of [
      'knowledgeApi.wiki.pageDelete(',
      'knowledgeApi.wiki.rawList(',
      'knowledgeApi.wiki.rawRead(',
      'knowledgeApi.wiki.rawDelete(',
      'knowledgeApi.wiki.upload(',
    ]) {
      expect(src).toContain(call);
    }
  });

  it('删除是两段式（没有弹窗也不许一点就删）', () => {
    const src = deepSrc();
    expect(src).toContain("confirmName === sel ? '确认删除' : '删除文档'");
    expect(src).toContain("confirmPath === path ? '确认删除' : '删除本页'");
    // 一次点击只能进入待确认态，不能直接调删除
    expect(src).toMatch(/confirmName === sel \? void remove\(sel\) : setConfirmName\(sel\)/);
    expect(src).toMatch(/confirmPath === path \? void removePage\(path\) : setConfirmPath\(path\)/);
  });

  it('知识站有「原始文档」分区，且上传带上团队上下文', () => {
    const src = stationSrc();
    expect(src).toContain("{ value: 'raw', label: '原始文档' }");
    expect(src).toContain('<WikiRawPanel wikiId={current.id} teamId={sm.teamId ?? \'\'} />');
    expect(deepSrc()).toContain("if (!teamId) throw new Error('缺少团队上下文，无法上传')");
  });
});

describe('站台抽屉不再嵌旧页（P7 验收）', () => {
  const src = readFileSync(fileURLToPath(new URL('../../StarmapLayout.tsx', import.meta.url)), 'utf8');

  it('没有 ?full=1 嵌入通道', () => {
    expect(src).not.toContain("set('full'");
    expect(src).not.toContain('full && legacy');
  });

  it('没有 st-embed 容器，也不再 import 旧页面', () => {
    expect(src).not.toContain('st-embed');
    expect(src).not.toMatch(/from '@\/pages\//);
  });

  it('旧控制台是显式路由出口，不是同页嵌入', () => {
    expect(src).toContain("nav('/legacy'");
  });
});

describe('代码关系图谱（G4）', () => {
  it('代码站有「关系图」分区，并把选中资产喂给它', () => {
    const src = stationSrc();
    expect(src).toContain("{ value: 'graph', label: '关系图' }");
    expect(src).toContain('<CodeGraphPanel codeGraphId={current.id} />');
  });

  it('关系图走缓存层取数（fetchCodeStructure + useApiResource），不自己直连端点', () => {
    const src = deepSrc();
    const panel = src.slice(src.indexOf('export function CodeGraphPanel'));
    expect(panel).toContain('fetchCodeStructure(');
    expect(panel).toContain('useApiResource(');
    // 这两条是灵魂泳道自锁的护栏：panel 自己不调 store，也不直接打 knowledgeApi.code.structure
    expect(panel).not.toContain('starmapStore.load');
    expect(panel).not.toContain('knowledgeApi.code.structure');
  });

  it('边只来自服务端，不伪造关系', () => {
    // 造边在 buildCodeGraphRel 里（面板调用它），所以从那个函数开始切
    const panel = deepSrc().slice(deepSrc().indexOf('function buildCodeGraphRel'));
    expect(panel).toContain('edges.map(');
    // 不许在面板里凭空造边（比如给所有兄弟节点补一条 calls）
    expect(panel).not.toMatch(/kind:\s*\x27calls\x27/);
    expect(panel).not.toMatch(/kind:\s*\x27imports\x27/);
  });

  it('截断与总数如实写出来，不假装画了全图', () => {
    const src = deepSrc();
    expect(src).toContain('服务端共 ');
    expect(src).toContain('已截断');
    expect(src).toContain('三跳邻域');
    expect(src).toContain('CODE_GRAPH_LIMIT = 120');
  });

  it('星点键盘可达：方向键走位、回车选中、有 role 与 aria-label', () => {
    const src = graphCanvasSrc();
    expect(src).toContain('role="application"');
    expect(src).toContain('tabIndex={0}');
    expect(src).toContain('onKeyDown={onKeyDown}');
    for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'Enter', ' ']) {
      expect(src).toContain(key);
    }
    expect(src).toMatch(/aria-label=\{\x27关系星图，\x27/);
    expect(src).toContain('方向键在星点之间移动，回车打开详情');
  });

  it('关系列表按「节点+关系」去重（同一对节点有多条边时只出一行）', () => {
    expect(deepSrc()).toContain("const sig = other + '|' + e.kind");
    expect(deepSrc()).toContain('if (seen.has(sig)) continue');
  });

  it('一进图就选中中心节点（右栏不留空）', () => {
    expect(deepSrc()).toContain('setSel((cur) => cur ?? built.hub)');
  });

  it('星场不掷骰子：摆位只由数据决定', () => {
    expect(stripComments(graphCanvasSrc())).not.toContain('Math.random');
  });

  it('键盘聚焦有可见焦点环（canvas 拿不到默认样式）', () => {
    expect(kitSrc()).toContain('.stk-graph-canvas canvas:focus-visible');
    expect(kitSrc()).toContain('outline: 2px solid var(--focus)');
  });
});