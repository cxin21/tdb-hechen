import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import '../tokens.css';
import { Btn, Card2, Fields, Note, Pill, Seg, StatRow } from '../ui';

/** P6 兼容层离线预览：全部走旧名字，看渲染出来是不是 kit 的样子。 */
function Demo() {
  return h('div', { className: 'starmap-root', style: { padding: 24, display: 'grid', gap: 16, gridTemplateColumns: '1fr 1fr' } },
    h(Card2, { title: '记忆块', en: 'BLOCKS', right: h('span', { className: 'sm-dim2' }, '3') },
      h('div', { style: { display: 'grid', gap: 10 } },
        h(StatRow, { items: [{ label: 'L3 稳定结论', value: 1 }, { label: 'L2 经验', value: 15 }, { label: 'L1 回合', value: 11480 }, { label: 'L0 原始', value: 14782 }] }),
        h(Fields, { items: [{ k: '块 id', v: 'blk-2k12lgb650', mono: true }, { k: '范围', v: h(Pill, { tone: 'on', children: '私密' }) }, { k: '最近写入', v: '2026-11-11 12:03' }] }),
        h(Seg, { value: 'l1', options: [{ value: 'l0', label: 'L0' }, { value: 'l1', label: 'L1' }, { value: 'l2', label: 'L2' }, { value: 'l3', label: 'L3' }], onChange: () => {} }),
        h(Note, { tone: 'warn', children: '数据未刷新：上次同步 12:03' }),
        h('div', { style: { display: 'flex', gap: 8 } },
          h(Btn, { primary: true, small: true, children: '进入忆云' }),
          h(Btn, { ghost: true, small: true, children: '退出' }),
          h(Btn, { danger: true, small: true, children: '删除块' }),
        ),
      )),
    h(Card2, { title: '星点详情', en: 'INSPECTOR' },
      h('div', { style: { display: 'grid', gap: 10 } },
        h(Fields, { items: [{ k: '节点键', v: 'mem:L1:9f3c', mono: true }, { k: '显著性', v: '0.82' }, { k: '来源', v: '' }] }),
        h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
          h(Pill, { tone: 'ok', children: 'active' }),
          h(Pill, { tone: 'warn', children: 'private' }),
          h(Pill, { children: 'user' }),
        ),
      )),
  );
}

createRoot(document.getElementById('root')!).render(h(Demo));
