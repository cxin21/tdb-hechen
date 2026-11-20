import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { KvList } from '../KvList';
import { Pager } from '../Pager';
import { Row } from '../Row';
import { StarDetail } from '../StarDetail';
import { Surface } from '../Surface';

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe('Surface', () => {
  it('渲染标题行与右端附属内容', () => {
    const out = html(createElement(Surface, { title: '记忆星云', aside: '14,782' }, 'body'));
    expect(out).toContain('stk-surface');
    expect(out).toContain('记忆星云');
    expect(out).toContain('stk-surface-aside');
    expect(out).toContain('14,782');
  });

  it('不传 title 时不产生空标题行（避免顶部多出一条空带）', () => {
    const out = html(createElement(Surface, null, 'body'));
    expect(out).not.toContain('stk-surface-h');
  });

  it('dense 与 as 生效', () => {
    const out = html(createElement(Surface, { dense: true, as: 'aside' }, 'x'));
    expect(out).toMatch(/^<aside[^>]*is-dense/);
  });
});

describe('Row', () => {
  it('可点行用真按钮，键盘可达', () => {
    const out = html(createElement(Row, { label: 'L1 对话记忆', onClick: () => {} }));
    expect(out).toContain('<button');
    expect(out).toContain('type="button"');
  });

  it('选中行同时给 is-active 与 aria-current', () => {
    const out = html(createElement(Row, { label: 'L1', active: true, onClick: () => {} }));
    expect(out).toContain('is-active');
    expect(out).toContain('aria-current="true"');
  });

  it('禁用行带 disabled 与 is-disabled', () => {
    const out = html(createElement(Row, { label: 'L1', disabled: true, onClick: () => {} }));
    expect(out).toContain('is-disabled');
    expect(out).toContain('disabled');
  });

  it('不可点行不渲染按钮（避免给静态行加 tab 停靠点）', () => {
    const out = html(createElement(Row, { label: '静态' }));
    expect(out).not.toContain('<button');
  });

  it('meta 与 trailing 分列，不会把按钮塞进按钮', () => {
    const out = html(
      createElement(Row, {
        label: '行',
        meta: '3',
        trailing: createElement('span', null, '徽标'),
        onClick: () => {},
      }),
    );
    const buttons = out.match(/<button/g) ?? [];
    expect(buttons).toHaveLength(1);
    expect(out).toContain('stk-row-tail');
  });
});

describe('KvList', () => {
  it('空值统一破折号，不出现空白', () => {
    const out = html(
      createElement(KvList, {
        items: [
          { k: '层', v: 'L1' },
          { k: '会话', v: null },
        ],
      }),
    );
    expect(out).toContain('is-empty');
    expect(out).toContain('—');
  });

  it('mono 项加等宽类', () => {
    const out = html(createElement(KvList, { items: [{ k: 'id', v: 'mem-1', mono: true }] }));
    expect(out).toContain('is-mono');
  });

  it('空清单不渲染 dl', () => {
    expect(html(createElement(KvList, { items: [] }))).toBe('');
  });
});

describe('Pager', () => {
  it('当前页带 aria-current，且只有一处 is-on（不画方框，靠短线）', () => {
    const out = html(
      createElement(Pager, { page: 1, pages: 8, total: 780, pageSize: 100, onChange: () => {} }),
    );
    expect(out).toContain('aria-current="page"');
    expect(out.match(/is-on/g)).toHaveLength(1);
    expect(out).toContain('共 780 条');
    expect(out).toContain('第 1/8 页');
  });

  it('首页时上一页禁用、尾页时下一页禁用', () => {
    const first = html(createElement(Pager, { page: 1, pages: 8, total: 780, onChange: () => {} }));
    expect(first).toContain('aria-label="上一页"');
    expect(first).toMatch(/aria-label="上一页"[^>]*disabled|disabled[^>]*aria-label="上一页"/);
    const last = html(createElement(Pager, { page: 8, pages: 8, total: 780, onChange: () => {} }));
    expect(last).toMatch(/aria-label="下一页"[^>]*disabled|disabled[^>]*aria-label="下一页"/);
  });

  it('loading 时所有翻页按钮都禁用，防连点重复请求', () => {
    const out = html(
      createElement(Pager, { page: 3, pages: 8, total: 780, loading: true, onChange: () => {} }),
    );
    const nums = out.match(/<button[^>]*stk-pager-num[^>]*>/g) ?? [];
    expect(nums.length).toBeGreaterThan(0);
    expect(nums.every((b) => b.includes('disabled'))).toBe(true);
  });
});

describe('StarDetail', () => {
  it('没选中星时给空态，不渲染半张空卡', () => {
    const out = html(createElement(StarDetail, { emptyText: '点一颗星看详情' }));
    expect(out).toContain('点一颗星看详情');
    expect(out).not.toContain('stk-detail-title');
  });

  it('版式顺序固定：标题→副标→键值→关系→折叠全文→操作', () => {
    const out = html(
      createElement(StarDetail, {
        title: 'mem-1 部署结论',
        subtitle: createElement('span', null, 'L1 · 2026-11-10'),
        kv: [{ k: '来源', v: 'session-abc' }],
        relations: [{ tone: 'l0', label: '源 L0 消息', meta: '3' }],
        body: '加固后的正文',
        actions: createElement('button', null, '分配'),
      }),
    );
    const order = ['stk-detail-title', 'stk-detail-sub', 'stk-kv', 'stk-sec', 'stk-detail-fold', 'stk-detail-actions'].map(
      (needle) => out.indexOf(needle),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('全文进折叠区，并标出字数', () => {
    const out = html(createElement(StarDetail, { title: 't', body: '一二三四五' }));
    expect(out).toContain('<details');
    expect(out).toContain('展开全文 · 5 字');
  });

  it('正文为空时不渲染折叠区（不出现空的「展开全文」）', () => {
    const out = html(createElement(StarDetail, { title: 't', body: '   ' }));
    expect(out).not.toContain('<details');
  });
});
