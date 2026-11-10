/**
 * AgentPersonaSection —— 「人格设定」表单区 + 特质两栏（spec §1/§5）。
 *
 * 六项里的「名称」不在这里重复一份：它就用弹窗上方那个 Agent 名称输入（保存时内核会把
 * 同一个值写回显示名，F7）。这里只承载形象 / 说话方式 / 使命 / 特质 / 红线，
 * 右侧并排一栏「它现在」，数据来自 GET /api/v1/chat-memory/soul-trait-state。
 *
 * 读侧纪律（判据 12）：文案里只有中文标签（严谨/迷糊/…）与「你设定的 / 它现在 / 已漂移 /
 * 还没长出来」，不出现任何取值方式的说明。
 *
 * 边界：本组件只做展示与即时提示；超限**不静默截断**，由调用方禁用保存按钮并展示原因。
 */
import { useEffect, useMemo, useState } from 'react';
import { Input } from 'tea-component';
import { readAuth } from '@/components/LoginGate';
import { fetchSoulTraitState, type SoulTraitStatePayload } from '@/lib/api/chat-memory-soul';
import {
  PERSONA_LIMITS,
  SEED_TRAIT_OPTIONS,
  previewSeedWeights,
  redlineHints,
  validatePersonaDraft,
  type AgentPersonaDraft,
  type PersonaRedline,
  type PersonaTraitValue,
} from '@/lib/agent-persona-form';

/** 字数（按字符而非 UTF-16 码元，与服务端口径一致）。 */
function charLen(v: string): number {
  return Array.from(v).length;
}

function charCounter(value: string, max: number) {
  const used = charLen(value);
  return (
    <div className={'_memory-persona-counter' + (used > max ? ' _memory-persona-counter--over' : '')}>
      {used}/{max} 字
    </div>
  );
}

/** 右侧「它现在」一栏：只读，加载失败原样显示后端 message。 */
function TraitMirror({
  teamId,
  agentId,
  reloadToken,
}: {
  teamId: string;
  agentId?: string;
  reloadToken: number;
}) {
  const userId = readAuth()?.user_id ?? '';
  const [payload, setPayload] = useState<SoulTraitStatePayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!teamId || !agentId) {
      setPayload(null);
      return;
    }
    let alive = true;
    setLoading(true);
    setError('');
    fetchSoulTraitState({ teamId, userId: userId || undefined, agentId })
      .then((data) => {
        if (alive) setPayload(data);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [teamId, agentId, userId, reloadToken]);

  // 只列「设定过」或「已经长出来」的标签；18 条全列出会淹没真正有信息的几行。
  const rows = useMemo(
    () => (payload?.traits ?? []).filter((t) => t.seedWeight > 0 || t.nowWeight > 0),
    [payload],
  );
  const neverGrown = payload !== null && payload.updatedAt === null;

  return (
    <aside className="_memory-persona-mirror" aria-label="它现在">
      <div className="_memory-persona-mirror-title">它现在</div>
      {!agentId ? (
        <div className="_memory-persona-mirror-empty">创建之后，才会开始积累它自己的状态。</div>
      ) : loading ? (
        <div className="_memory-persona-mirror-empty">读取中…</div>
      ) : error ? (
        <div className="_memory-persona-mirror-error">{error}</div>
      ) : rows.length === 0 ? (
        <div className="_memory-persona-mirror-empty">
          {neverGrown ? '还没长出来' : '还没有设定特质，也没有积累出可展示的状态。'}
        </div>
      ) : (
        <>
          {neverGrown && <div className="_memory-persona-mirror-empty">还没长出来</div>}
          <div className="_memory-persona-mirror-head">
            <span>标签</span>
            <span>你设定的</span>
            <span>它现在</span>
            <span />
          </div>
          {rows.map((row) => (
            <div key={row.label} className="_memory-persona-mirror-row">
              <span className="_memory-persona-mirror-label">{row.label}</span>
              <span className="_memory-persona-mirror-value">
                {row.seedWeight > 0 ? row.seedWeight.toFixed(2) : '—'}
              </span>
              <span className="_memory-persona-mirror-value">
                {neverGrown ? '—' : row.nowWeight.toFixed(2)}
              </span>
              <span>
                {row.drifted && !neverGrown && (
                  <span className="_memory-persona-drift-badge">已漂移</span>
                )}
              </span>
            </div>
          ))}
          {payload?.updatedAt && (
            <div className="_memory-persona-mirror-foot">
              最近更新：{new Date(payload.updatedAt).toLocaleString()}
            </div>
          )}
        </>
      )}
    </aside>
  );
}

export default function AgentPersonaSection({
  teamId,
  agentId,
  name,
  draft,
  onChange,
  retiredRedlines = [],
  reloadToken = 0,
}: {
  teamId: string;
  /** 创建弹窗里还没有 agent_id：右侧两栏显示「创建之后才会开始积累」。 */
  agentId?: string;
  /** Agent 显示名（与上方名称输入同源），用于长度校验提示。 */
  name: string;
  draft: AgentPersonaDraft;
  onChange: (next: AgentPersonaDraft) => void;
  /** 已退役的红线：只读展示，不参与本次提交。 */
  retiredRedlines?: PersonaRedline[];
  /** 保存后 +1，让右侧「它现在」重新拉一次。 */
  reloadToken?: number;
}) {
  const errors = validatePersonaDraft(name, draft);
  const hints = redlineHints(draft.redlinesText);
  const normalized = previewSeedWeights(draft.traits);
  const atMax = draft.traits.length >= PERSONA_LIMITS.traitsMax;

  function patch(next: Partial<AgentPersonaDraft>) {
    onChange({ ...draft, ...next });
  }

  function toggleTrait(label: string) {
    const exists = draft.traits.some((t) => t.label === label);
    if (exists) {
      patch({ traits: draft.traits.filter((t) => t.label !== label) });
      return;
    }
    if (atMax) return;
    patch({ traits: [...draft.traits, { label, weight: 0.5 }] });
  }

  function setWeight(label: string, weight: number) {
    patch({
      traits: draft.traits.map((t): PersonaTraitValue =>
        t.label === label ? { ...t, weight } : t,
      ),
    });
  }

  return (
    <section className="_memory-persona-section">
      <div className="_memory-persona-head">
        <div className="_memory-persona-title">人格设定</div>
        <div className="_memory-persona-sub">
          名称就用上方的同一栏（保存时会一起写回显示名）；这里写的是它「是谁」，不是做什么。
        </div>
      </div>

      <div className="_memory-persona-columns">
        <div className="_memory-persona-form">
          <label className="_memory-light-field">
            <div className="_memory-light-field-label">形象</div>
            <div className="_memory-light-field-hint">一句具象的自述：它怎么看自己。</div>
            <Input.TextArea
              size="full"
              rows={3}
              value={draft.selfImage}
              onChange={(v: string) => patch({ selfImage: v })}
              placeholder="例如：一个把话说明白、不爱绕的人。"
            />
            {charCounter(draft.selfImage, PERSONA_LIMITS.selfImageMaxChars)}
          </label>

          <label className="_memory-light-field">
            <div className="_memory-light-field-label">说话方式</div>
            <div className="_memory-light-field-hint">怎么开口、句子长短、语气。</div>
            <Input.TextArea
              size="full"
              rows={2}
              value={draft.voice}
              onChange={(v: string) => patch({ voice: v })}
              placeholder="例如：先给结论，再补依据；句子短，不绕弯。"
            />
            {charCounter(draft.voice, PERSONA_LIMITS.voiceMaxChars)}
          </label>

          <label className="_memory-light-field">
            <div className="_memory-light-field-label">使命</div>
            <div className="_memory-light-field-hint">一句长期取向：它打算一直把什么做好。</div>
            <Input.TextArea
              size="full"
              rows={2}
              value={draft.purpose}
              onChange={(v: string) => patch({ purpose: v })}
              placeholder="例如：把没验过的东西当成没做完。"
            />
            {charCounter(draft.purpose, PERSONA_LIMITS.purposeMaxChars)}
          </label>

          <div className="_memory-light-field">
            <div className="_memory-light-field-label">
              特质（最多 {PERSONA_LIMITS.traitsMax} 个，已选 {draft.traits.length} 个）
            </div>
            <div className="_memory-light-field-hint">
              点选标签，再拉一项的强弱；保存时会按比例归一，只影响它往后怎么表现。
            </div>
            <div className="_memory-persona-chips">
              {SEED_TRAIT_OPTIONS.map((opt) => {
                const selected = draft.traits.some((t) => t.label === opt.label);
                return (
                  <button
                    key={opt.label}
                    type="button"
                    title={opt.gloss}
                    aria-pressed={selected}
                    disabled={!selected && atMax}
                    className={
                      '_memory-persona-chip' + (selected ? ' _memory-persona-chip--active' : '')
                    }
                    onClick={() => toggleTrait(opt.label)}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
            {atMax && (
              <div className="_memory-field-hint">
                已到 {PERSONA_LIMITS.traitsMax} 个上限，先取消一个再加。
              </div>
            )}
            {draft.traits.length > 0 && (
              <div className="_memory-persona-weights">
                {draft.traits.map((trait) => {
                  const preview = normalized.find((n) => n.label === trait.label)?.weight ?? 0;
                  return (
                    <div key={trait.label} className="_memory-persona-weight-row">
                      <span className="_memory-persona-weight-label">{trait.label}</span>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={trait.weight}
                        aria-label={`${trait.label} 强弱`}
                        onChange={(e) => setWeight(trait.label, Number(e.target.value))}
                      />
                      <span className="_memory-persona-weight-value">
                        {trait.weight.toFixed(2)}
                      </span>
                      <span className="_memory-persona-weight-preview">归一后 {preview.toFixed(2)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <label className="_memory-light-field">
            <div className="_memory-light-field-label">
              红线（一行一条，最多 {PERSONA_LIMITS.redlineMaxRows} 行，每行{' '}
              {PERSONA_LIMITS.redlineLineMaxChars} 字以内）
            </div>
            <div className="_memory-light-field-hint">它不该越过的界线，写具体行为，不写口号。</div>
            <Input.TextArea
              size="full"
              rows={5}
              value={draft.redlinesText}
              onChange={(v: string) => patch({ redlinesText: v })}
              placeholder={'例如：不替用户做决定\n不编造没验过的结论'}
              className="_memory-mono-textarea"
            />
            {charCounter(draft.redlinesText, PERSONA_LIMITS.redlineTotalMaxChars)}
            {hints.length > 0 && (
              <div className="_memory-persona-error">
                {hints.map((h) => (
                  <div key={h}>{h}</div>
                ))}
              </div>
            )}
          </label>

          {retiredRedlines.length > 0 && (
            <div className="_memory-light-field">
              <div className="_memory-light-field-label">已退役的红线（只读）</div>
              <div className="_memory-persona-retired">
                {retiredRedlines.map((r) => (
                  <div key={(r.createdAt ?? '') + r.text} className="_memory-persona-retired-row">
                    <span className="_memory-persona-retired-badge">已退役</span>
                    <span>{r.text}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {errors.length > 0 && (
            <div className="_memory-form-error _memory-persona-error">
              {errors.map((e) => (
                <div key={e}>{e}</div>
              ))}
            </div>
          )}
        </div>

        <TraitMirror teamId={teamId} agentId={agentId} reloadToken={reloadToken} />
      </div>
    </section>
  );
}
