/**
 * PersonArchivePanel —— 「人物档案」只读视图（人格 v4 阶段 2 P2-H 的读侧）。
 *
 * 左侧人物列表（名字 + 别名 + 字段数/关系度数），右侧选中那人的九字段与依据，
 * 下方全员关系图（见 PersonRelationGraph）。数据来自两条只读 BFF 路由：
 *   GET /api/v1/soul/persons、GET /api/v1/soul/person?key=p_xxx
 *
 * 生产首屏就是「4 个人、0 条关系边、0 个字段」——所以「档案为空」是正常状态，
 * 写成说明而不是空白或报错；stale 只说「依据已过期」，不当错误。
 *
 * 全页只读：不提供任何写入口。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  fetchSoulPerson,
  fetchSoulPersons,
  type SoulPersonDetailPayload,
  type SoulPersonEdge,
  type SoulPersonRow,
  type SoulPersonsPayload,
  type SoulProfileField,
  type SoulProfileRelation,
} from '@/lib/api/chat-memory-soul';
import { ApiError } from '@/lib/api/base';
import { getErrorMessage } from '@/lib/error-message';
import { PersonRelationGraph } from './PersonRelationGraph';

interface PersonArchivePanelProps {
  teamId: string;
  agentId?: string;
  userId?: string;
}

/** 九字段的固定顺序与中文名（与 Core PERSON_PROFILE_FIELD_ORDER 一致）。 */
const PROFILE_FIELDS: ReadonlyArray<{ field: string; label: string }> = [
  { field: 'alias', label: '称呼' },
  { field: 'role', label: '身份' },
  { field: 'style', label: '说话方式' },
  { field: 'likes', label: '喜欢' },
  { field: 'dislikes', label: '反感' },
  { field: 'focus', label: '近况' },
  { field: 'story', label: '经历' },
  { field: 'promise', label: '约定' },
  { field: 'handle', label: '相处' },
];

type ListState =
  | { status: 'loading' }
  | { status: 'ok'; data: SoulPersonsPayload }
  | { status: 'failed'; message: string };

type DetailState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; data: SoulPersonDetailPayload }
  | { status: 'gone'; message: string }
  | { status: 'failed'; message: string };

function formatAt(at: string | null): string {
  if (!at) return '时间未记';
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 关系里「对方」的名字：out 用 objName；in 的 objName 是本人，得按 counterpartKey 反查。 */
function counterpartName(
  rel: SoulProfileRelation,
  nameByKey: Map<string, string>,
): string {
  if (rel.direction === 'in') {
    return (rel.counterpartKey ? nameByKey.get(rel.counterpartKey) : undefined) ?? '没有登记的人';
  }
  return rel.objName ?? (rel.objKey ? nameByKey.get(rel.objKey) : undefined) ?? '没有登记的人';
}

const DIRECTION_LABEL: Record<SoulProfileRelation['direction'], string> = {
  out: '指向',
  in: '来自',
  mutual: '互相',
};

export function PersonArchivePanel({ teamId, agentId, userId }: PersonArchivePanelProps) {
  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState>({ status: 'idle' });
  const [reloadTick, setReloadTick] = useState(0);

  const loadList = useCallback(async () => {
    setList((prev) => (prev.status === 'ok' ? prev : { status: 'loading' }));
    try {
      const data = await fetchSoulPersons({ teamId, userId, agentId });
      setList({ status: 'ok', data });
    } catch (err) {
      setList({ status: 'failed', message: getErrorMessage(err) });
    }
  }, [teamId, userId, agentId]);

  useEffect(() => {
    void loadList();
  }, [loadList, reloadTick]);

  // 选中项跟随列表：默认选第一个；列表里没了就退回第一个（不悬空）。
  useEffect(() => {
    if (list.status !== 'ok') return;
    const persons = list.data.persons;
    if (persons.length === 0) {
      setSelectedKey(null);
      return;
    }
    if (!selectedKey || !persons.some((p) => p.key === selectedKey)) {
      setSelectedKey(persons[0].key);
    }
  }, [list, selectedKey]);

  useEffect(() => {
    if (!selectedKey) {
      setDetail({ status: 'idle' });
      return;
    }
    let cancelled = false;
    setDetail({ status: 'loading' });
    void (async () => {
      try {
        const data = await fetchSoulPerson({ teamId, userId, agentId, key: selectedKey });
        if (!cancelled) setDetail({ status: 'ok', data });
      } catch (err) {
        if (cancelled) return;
        const status = err instanceof ApiError ? err.status : 0;
        if (status === 404) {
          setDetail({ status: 'gone', message: getErrorMessage(err) });
        } else {
          setDetail({ status: 'failed', message: getErrorMessage(err) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedKey, teamId, userId, agentId, reloadTick]);

  const persons: SoulPersonRow[] = list.status === 'ok' ? list.data.persons : [];
  const edges: SoulPersonEdge[] = list.status === 'ok' ? list.data.edges : [];
  const nameByKey = useMemo(
    () => new Map(persons.map((p) => [p.key, p.displayName])),
    [persons],
  );

  const fieldByCode = useMemo(() => {
    if (detail.status !== 'ok') return new Map<string, SoulProfileField>();
    return new Map(detail.data.fields.map((f) => [f.field, f]));
  }, [detail]);

  // 上游若将来多出九字段之外的字段，按原顺序追加在后面（不丢）。
  const extraFields = useMemo(() => {
    if (detail.status !== 'ok') return [] as SoulProfileField[];
    const known = new Set(PROFILE_FIELDS.map((f) => f.field));
    return detail.data.fields.filter((f) => !known.has(f.field));
  }, [detail]);

  return (
    <section className="_soul-section" id="_soul-sec-persons">
      <div className="_soul-section-head">
        <div className="_soul-section-title">人物档案</div>
        <div className="_soul-meta">只读 · 从对话记忆里一点点提炼出来，没有依据的地方就空着</div>
      </div>

      {list.status === 'loading' ? (
        <div className="_soul-empty">正在读人物档案…</div>
      ) : list.status === 'failed' ? (
        <div className="_soul-empty">
          读不到人物档案：{list.message}
          <button
            type="button"
            className="_soul-person-retry"
            onClick={() => setReloadTick((n) => n + 1)}
          >
            重试
          </button>
        </div>
      ) : persons.length === 0 ? (
        <div className="_soul-empty">
          还没有登记的人。等有过对话、能从记忆里认出是谁之后，这里才会出现人物。
        </div>
      ) : (
        <>
          <div className="_soul-person-layout">
            <ul className="_soul-person-list">
              {persons.map((p) => (
                <li key={p.key}>
                  <button
                    type="button"
                    className={
                      '_soul-person-item' +
                      (p.key === selectedKey ? ' _soul-person-item--active' : '')
                    }
                    onClick={() => setSelectedKey(p.key)}
                  >
                    <span className="_soul-person-name">{p.displayName}</span>
                    {p.aliases.length > 0 ? (
                      <span className="_soul-meta">也叫 {p.aliases.join('、')}</span>
                    ) : null}
                    <span className="_soul-person-counts">
                      {p.fieldCount} 个字段 · {p.relationCount} 条关系
                    </span>
                  </button>
                </li>
              ))}
            </ul>

            <div className="_soul-person-detail">
              {detail.status === 'idle' || detail.status === 'loading' ? (
                <div className="_soul-empty">正在读这个人的档案…</div>
              ) : detail.status === 'gone' ? (
                <div className="_soul-empty">
                  这个人已经不在档案里了（可能被合并或清理），换左边的人看看。
                  <div className="_soul-meta">{detail.message}</div>
                </div>
              ) : detail.status === 'failed' ? (
                <div className="_soul-empty">
                  读不到这个人的档案：{detail.message}
                  <button
                    type="button"
                    className="_soul-person-retry"
                    onClick={() => setReloadTick((n) => n + 1)}
                  >
                    重试
                  </button>
                </div>
              ) : (
                <>
                  <div className="_soul-person-detail-head">
                    <span className="_soul-person-detail-name">{detail.data.person.displayName}</span>
                    {detail.data.person.aliases.length > 0 ? (
                      <span className="_soul-meta">
                        也叫 {detail.data.person.aliases.join('、')}
                      </span>
                    ) : null}
                  </div>

                  {detail.data.fields.length === 0 ? (
                    <div className="_soul-meta _soul-person-blank-note">
                      这个人还没有提炼出档案 —— 依据还不够（比如只在很少几次对话里出现过）。
                      等有足够的原话之后，下面这几个方面才会陆续长出来。
                    </div>
                  ) : null}

                  <dl className="_soul-person-fields">
                    {PROFILE_FIELDS.map((def) => {
                      const f = fieldByCode.get(def.field);
                      return (
                        <div key={def.field} className="_soul-person-field">
                          <dt className="_soul-person-field-label">{f?.label ?? def.label}</dt>
                          <dd className="_soul-person-field-body">
                            {f && f.text ? (
                              <>
                                <span className="_soul-person-field-text">{f.text}</span>
                                {f.stale ? (
                                  <span
                                    className="_soul-person-stale"
                                    title="这条依据已经过期，还留着看，等新的对话把它刷新"
                                  >
                                    依据已过期
                                  </span>
                                ) : null}
                                {f.evidence.length > 0 ? (
                                  <details className="_soul-person-evidence">
                                    <summary>依据 {f.evidence.length} 条</summary>
                                    <ul>
                                      {f.evidence.map((ev, idx) => (
                                        <li key={`${ev.recordId}-${idx}`}>
                                          <p className="_soul-person-quote">「{ev.quote}」</p>
                                          <div className="_soul-meta">
                                            {formatAt(ev.at)}
                                            {ev.recordId ? ` · ${ev.recordId}` : ''}
                                          </div>
                                        </li>
                                      ))}
                                    </ul>
                                  </details>
                                ) : null}
                              </>
                            ) : (
                              <span className="_soul-person-field-missing">还没有依据</span>
                            )}
                          </dd>
                        </div>
                      );
                    })}
                    {extraFields.map((f) => (
                      <div key={f.field} className="_soul-person-field">
                        <dt className="_soul-person-field-label">{f.label}</dt>
                        <dd className="_soul-person-field-body">
                          <span className="_soul-person-field-text">{f.text}</span>
                        </dd>
                      </div>
                    ))}
                  </dl>

                  <div className="_soul-person-subhead">关系</div>
                  {detail.data.relations.length === 0 ? (
                    <div className="_soul-meta">还没有提炼出关系。</div>
                  ) : (
                    <ul className="_soul-person-relations">
                      {detail.data.relations.map((rel) => {
                        const name = counterpartName(rel, nameByKey);
                        const selectable =
                          rel.direction !== 'in' &&
                          rel.objKey !== null &&
                          persons.some((p) => p.key === rel.objKey);
                        return (
                          <li key={rel.relId} className="_soul-person-relation">
                            <span className="_soul-person-relation-dir">
                              {DIRECTION_LABEL[rel.direction]}
                            </span>
                            {selectable ? (
                              <button
                                type="button"
                                className="_soul-person-link"
                                onClick={() => setSelectedKey(rel.objKey)}
                              >
                                {name}
                              </button>
                            ) : (
                              <span>{name}</span>
                            )}
                            <span className="_soul-person-relation-pred">{rel.pred}</span>
                            {rel.quote ? (
                              <div className="_soul-person-quote">「{rel.quote}」</div>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </>
              )}
            </div>
          </div>

          <div className="_soul-person-subhead">关系图</div>
          <PersonRelationGraph
            persons={persons}
            edges={edges}
            selectedKey={selectedKey}
            onSelect={setSelectedKey}
          />
        </>
      )}
    </section>
  );
}