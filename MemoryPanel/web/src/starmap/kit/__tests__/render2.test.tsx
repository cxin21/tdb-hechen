import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Dialog } from '../Dialog';
import { Gate } from '../Gate';
import { Legend } from '../Legend';
import { MetricRow } from '../MetricRow';
import { ScopeBar } from '../ScopeBar';
import { Seg } from '../Seg';
import { Empty, Note, Skeleton } from '../States';
import { Tag } from '../Tag';

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe('Seg', () => {
  it('选中项有 aria-pressed 与 is-on，只允许一个选中', () => {
    const out = html(
      createElement(Seg, {
        value: 'l1',
        options: [
          { value: 'l0', label: 'L0', count: 14782 },
          { value: 'l1', label: 'L1', count: 11480 },
        ],
        onChange: () => {},
      }),
    );
    expect(out.match(/is-on/g)).toHaveLength(1);
    expect(out.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(out).toContain('stk-seg-count');
  });
});

describe('Tag', () => {
  it('tone 生效，neutral 不加修饰类', () => {
    expect(html(createElement(Tag, { tone: 'warn', children: '未刷新' }))).toContain('stk-tag--warn');
    expect(html(createElement(Tag, null, '普通'))).not.toContain('stk-tag--');
  });
});

describe('States', () => {
  it('Empty 默认给人话标题', () => {
    expect(html(createElement(Empty, null))).toContain('这里还没有内容');
  });

  it('Skeleton 标 aria-busy，行数可控', () => {
    const out = html(createElement(Skeleton, { rows: 4 }));
    expect(out).toContain('aria-busy="true"');
    expect(out.match(/stk-skeleton-row/g)).toHaveLength(4);
  });

  it('Note 降级时为 status 角色并带时间戳', () => {
    const out = html(createElement(Note, { tone: 'warn', stamp: '12:03', children: '数据未刷新' }));
    expect(out).toContain('role="status"');
    expect(out).toContain('stk-note--warn');
    expect(out).toContain('12:03');
  });
});

describe('MetricRow / Gate / Legend', () => {
  it('计数缺失显示 — 而不是 0', () => {
    const out = html(createElement(Gate, { label: '记忆星云' }));
    expect(out).toContain('—');
    expect(out).not.toContain('>0<');
  });

  it('有计数时带单位与千分位', () => {
    const out = html(createElement(Gate, { label: '记忆', count: 14782, unit: '条', tone: 'l1' }));
    expect(out).toContain('14,782');
    expect(out).toContain('条');
    expect(out).toContain('stk-dot--l1');
  });

  it('降级态可区分', () => {
    expect(html(createElement(Gate, { label: '代码', degraded: true }))).toContain('is-degraded');
  });

  it('图例默认写明暗色含义', () => {
    const out = html(createElement(Legend, { items: [{ tone: 'l1', label: '亮' }] }));
    expect(out).toContain('暗＝团队可见、未挂到本 agent');
  });

  it('读数带单位且不画格线', () => {
    const out = html(
      createElement(MetricRow, { items: [{ k: 'L0', v: 14782, unit: '条', tone: 'l0' }] }),
    );
    expect(out).toContain('14,782');
    expect(out).toContain('stk-metric-unit');
  });
});

describe('ScopeBar', () => {
  it('团队与 agent 都渲染，且 value 绑定当前作用域', () => {
    const out = html(
      createElement(ScopeBar, {
        teams: [{ id: 't1', label: '团队一' }],
        teamId: 't1',
        agents: [
          { id: 'a1', label: 'Agent 一' },
          { id: 'a2', label: 'Agent 二' },
        ],
        agentId: 'a2',
        onTeam: () => {},
        onAgent: () => {},
      }),
    );
    expect(out).toContain('团队一');
    expect(out.match(/stk-select/g)).toHaveLength(2);
    expect(out).toContain('value="a2"');
  });

  it('不传 blocks 时不出现记忆块下拉', () => {
    const out = html(
      createElement(ScopeBar, {
        teams: [],
        teamId: '',
        agents: [],
        agentId: '',
        onTeam: () => {},
        onAgent: () => {},
      }),
    );
    expect(out.match(/stk-select/g)).toHaveLength(2);
    expect(out).toContain('无团队');
  });
});

describe('Dialog', () => {
  it('role/aria-modal/关闭按钮齐备', () => {
    const out = html(
      createElement(Dialog, { title: '导入记忆块', description: '选择本地文件', onClose: () => {} }, '内容'),
    );
    expect(out).toContain('role="dialog"');
    expect(out).toContain('aria-modal="true"');
    expect(out).toContain('aria-label="关闭"');
    expect(out).toContain('stk-overlay');
  });

  it('width 落到 maxWidth 且被 90vw 兜住', () => {
    const out = html(createElement(Dialog, { title: 't', width: 640, onClose: () => {} }));
    expect(out).toContain('min(640px, 90vw)');
  });
});
