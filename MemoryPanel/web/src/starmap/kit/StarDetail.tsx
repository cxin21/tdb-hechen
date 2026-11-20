import type { ReactNode } from 'react';
import { KvList, type KvItem } from './KvList';
import { Row } from './Row';
import { dotClass, type Tone } from './types';

export interface StarRelation {
  /** 关系边另一端的层/类型色。 */
  tone?: Tone;
  label: ReactNode;
  /** 右侧计数，例如「引用 3」。 */
  meta?: ReactNode;
  /** 点关系行＝把关联星点设为选中，不跳页、不关面板。 */
  onClick?: () => void;
}

export interface StarDetailProps {
  /** 不传标题视为「没有选中星」，渲染 emptyText。 */
  title?: ReactNode;
  subtitle?: ReactNode;
  kv?: KvItem[];
  relations?: StarRelation[];
  relationsTitle?: string;
  /** 原始全文，只在折叠区展示；不传则不渲染折叠区。 */
  body?: string | null;
  bodyLabel?: string;
  actions?: ReactNode;
  emptyText?: string;
  children?: ReactNode;
}

/**
 * 星点详情面板的唯一版式，顺序固定：
 * 标题 → 副标 → 键值 → 关系 → 折叠全文 → 操作。
 * 折叠区而不是直接铺全文，是为了让「关系」永远在首屏（关系是本界面的主要导航）。
 */
export function StarDetail(props: StarDetailProps) {
  if (props.title === undefined || props.title === null || props.title === '') {
    return (
      <div className="stk-detail">
        <div className="stk-detail-empty">{props.emptyText ?? '点一颗星看详情'}</div>
        {props.children}
      </div>
    );
  }

  const raw = typeof props.body === 'string' ? props.body : '';
  // 只有空白字符的正文等于没有正文：给它一张「展开全文 · 3 字」的折叠区是假的。
  const bodyText = raw.trim().length > 0 ? raw : null;
  const relations = props.relations ?? [];

  return (
    <div className="stk-detail">
      <h3 className="stk-detail-title">{props.title}</h3>
      {props.subtitle !== undefined ? <div className="stk-detail-sub">{props.subtitle}</div> : null}
      {props.kv && props.kv.length > 0 ? <KvList items={props.kv} /> : null}

      {relations.length > 0 ? (
        <div className="stk-sec">
          <p className="stk-sec-title">{props.relationsTitle ?? '关联'}</p>
          {relations.map((rel, i) => (
            <Row
              key={`rel-${i}`}
              leading={<span className={dotClass(rel.tone)} aria-hidden="true" />}
              label={rel.label}
              meta={rel.meta}
              onClick={rel.onClick}
            />
          ))}
        </div>
      ) : null}

      {bodyText ? (
        <details className="stk-detail-fold">
          <summary>
            {props.bodyLabel ?? `展开全文 · ${bodyText.trim().length} 字`}
          </summary>
          <pre className="stk-detail-pre">{bodyText}</pre>
        </details>
      ) : null}

      {props.actions !== undefined ? (
        <div className="stk-detail-actions">{props.actions}</div>
      ) : null}
      {props.children}
    </div>
  );
}
