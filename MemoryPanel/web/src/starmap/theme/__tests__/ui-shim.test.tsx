import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Btn, Card2, Dialog, Empty, Fields, Note, Pill, Seg, Skeleton, StatRow } from '../ui';

/**
 * P6 验收：旧组件名还在，但 DOM 里不许再出现旧类名与英文副标。
 * 判据是「渲染结果里没有」——所以这里直接数类名。
 */
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe('theme/ui 兼容层', () => {
  it('Card2 渲染成 Surface，不带 card2/ch/英文副标/live 点', () => {
    const out = html(
      createElement(Card2, { title: '记忆块', en: 'BLOCKS', right: createElement('span', null, '3') }, '内容'),
    );
    expect(out).toContain('stk-surface');
    expect(out).toContain('记忆块');
    expect(out).not.toContain('card2');
    expect(out).not.toContain('ch-en');
    expect(out).not.toContain('BLOCKS');
    expect(out).not.toContain('live-dot');
  });

  it('Pill → Tag，on 态映射到 ink', () => {
    const out = html(createElement(Pill, { tone: 'on', children: '私密' }));
    expect(out).toContain('stk-tag');
    expect(out).not.toContain('pill');
    expect(out).toContain('stk-tag--ink');
  });

  it('Fields → KvList：键列 + 空值统一破折号', () => {
    const out = html(createElement(Fields, { items: [{ k: '块 id', v: 'blk-1' }, { k: '范围', v: '' }] }));
    expect(out).toContain('stk-kv');
    expect(out).not.toContain('fields');
    expect(out).toContain('—');
  });

  it('StatRow → MetricRow，无格线单元格', () => {
    const out = html(createElement(StatRow, { items: [{ label: 'L0', value: 14782 }] }));
    expect(out).toContain('stk-metrics');
    expect(out).not.toContain('stat-cell');
    expect(out).toContain('14,782');
  });

  it('Btn 用 kit 类名，danger/small 都有对应变体', () => {
    const out = html(createElement(Btn, { danger: true, small: true, primary: true, children: '删除' }));
    expect(out).toContain('stk-btn');
    expect(out).toContain('is-danger');
    expect(out).toContain('is-sm');
    expect(out).not.toContain('sm-btn');
  });

  it('Empty / Skeleton / Note 走 kit 状态件', () => {
    expect(html(createElement(Empty, { text: '没有数据', hint: '换个筛选' }))).toContain('stk-empty');
    expect(html(createElement(Skeleton, { rows: 2 }))).toContain('stk-skeleton');
    const note = html(createElement(Note, { tone: 'warn', children: '数据未刷新' }));
    expect(note).toContain('stk-note--warn');
    expect(note).not.toContain('sm-note');
  });

  it('Seg 选中态是 is-on（底部短线），不是填充块', () => {
    const out = html(
      createElement(Seg, {
        value: 'all',
        options: [
          { value: 'all', label: '全部' },
          { value: 'mine', label: '已挂载' },
        ],
        onChange: () => {},
      }),
    );
    expect(out).toContain('stk-seg');
    expect(out).toContain('is-on');
    expect(out).not.toContain('rgba(60,120,200');
  });

  it('Dialog 走 kit 弹窗骨架（实底遮罩，无旧 dlg 类名）', () => {
    const out = html(createElement(Dialog, { title: '新建文档库', en: 'NEW', onClose: () => {}, children: '表单' }));
    expect(out).toContain('stk-dialog');
    expect(out).not.toContain('dlg-veil');
    expect(out).not.toContain('NEW');
  });
});
