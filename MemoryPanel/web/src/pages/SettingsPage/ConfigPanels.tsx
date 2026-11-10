/**
 * ConfigPanels.tsx — 设置页「配置面四档」中的 B / C / D 三个页签（2026-11-07）。
 *
 * 背景：配置项按「谁能改、改错什么后果」分四档（docs/ops/config-prune-2026-11-07.md）：
 *   A 部署身份/凭据 → 在「部署与凭据」页签（复用 ServiceSettingsPanel 的 llm/embedding）
 *   B 应急回滚总闸 → 本文件 EmergencySwitchesPanel（真写 override，可写）
 *   C 实测校准阈值 → 本文件 CalibrationPanel（真写 override，可写，但需实验数据）
 *   D 结构与协议常量 → 本文件 ConstantsPanel（只读清单，防误改；要改走代码评审）
 *
 * 写入链路与 Memory 页签完全一致：settingsApi.set('memory', { 段: … })
 *   → Panel /api/v1/settings/memory/set → Core /v3/admin/settings/set
 *   → settings-override 深合并（数组/标量整体替换、对象递归）→ config-override.json。
 * 生效时机：Core 重启后（/set 返回 needsRestart=true）；本页保存后提示。
 * 组内没有凭据，页签按普通对象回显，不做掩码。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Form, Input, Button, Tag, Checkbox, Select, Text } from 'tea-component';
import { settingsApi, type SettingsView } from '@/lib/api/settings';
import { tea } from '@/lib/tea-bridge';
import {
  CONFIG_CATALOG,
  CONFIG_TIER_DESC,
  type ConfigTier,
} from './configCatalog';

const HINT_STYLE = { display: 'block', marginTop: 4, fontSize: 12, color: '#8a8f99' } as const;
const WARN_STYLE = { display: 'block', marginTop: 4, fontSize: 12, color: '#e34d59' } as const;

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function bool(v: unknown, dflt = false): boolean {
  return typeof v === 'boolean' ? v : dflt;
}
function numStr(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
}

function useMemorySettings() {
  const [view, setView] = useState<SettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const v = await settingsApi.get('memory');
      setView(v);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      tea.notify.error(e);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return { view, error, reload: load };
}

// ───────────────────────────── B：应急开关 ─────────────────────────────

interface GateDef {
  /** 配置键路径（memory. 之下，用于展示）。 */
  path: string;
  label: string;
  /** 大白话：关掉之后会发生什么。 */
  offEffect: string;
  /** 从 settings get 视图取当前值。 */
  get: (v: SettingsView) => boolean | undefined;
  /** 折进 /set body。 */
  set: (body: Record<string, unknown>, on: boolean) => void;
  /** 默认值（配置缺省）。 */
  dflt: boolean;
}

const GATES: GateDef[] = [
  {
    path: 'memory.extraction.enabled',
    label: 'L1 抽取（extraction）',
    offEffect: '关掉：不再把 L0 会话抽成结构化记忆（人物/事实/偏好），检索层逐渐只剩旧数据。',
    get: (v) => {
      const e = rec(v.extraction).enabled;
      return typeof e === 'boolean' ? e : undefined;
    },
    set: (b, on) => {
      b.extraction = { ...rec(b.extraction), enabled: on };
    },
    dflt: true,
  },
  {
    path: 'memory.lifecycle.consolidation.enabled',
    label: '固化 / 合并（consolidation）',
    offEffect: '关掉：不做 L1→L2 周期性固化与合并，记忆条数持续增长且不收敛。',
    get: (v) => {
      const c = rec(rec(v.lifecycle).consolidation).enabled;
      return typeof c === 'boolean' ? c : undefined;
    },
    set: (b, on) => {
      const lc = rec(b.lifecycle);
      b.lifecycle = { ...lc, consolidation: { ...rec(lc.consolidation), enabled: on } };
    },
    dflt: true,
  },
  {
    path: 'memory.evolution.enabled',
    label: '自我演化（evolution）',
    offEffect: '关掉：全系统唯一允许改写已固化正文的路径停止，已写内容不再被演化。',
    get: (v) => {
      const e = rec(v.evolution).enabled;
      return typeof e === 'boolean' ? e : undefined;
    },
    set: (b, on) => {
      b.evolution = { ...rec(b.evolution), enabled: on };
    },
    dflt: false,
  },
  {
    path: 'memory.sceneGovernance.enabled',
    label: '场景块治理（sceneGovernance）',
    offEffect: '关掉：不做场景块抽取/蒸馏/硬上限治理，场景块只按旧逻辑累积。',
    get: (v) => {
      const e = rec(v.sceneGovernance).enabled;
      return typeof e === 'boolean' ? e : undefined;
    },
    set: (b, on) => {
      b.sceneGovernance = { ...rec(b.sceneGovernance), enabled: on };
    },
    dflt: false,
  },
  {
    path: 'memory.embedding.enabled',
    label: '向量通道（embedding）',
    offEffect: '关掉：不调 embedding 服务，召回降级为纯 FTS/BM25（语义相似失效）。通常只在上游故障时临时关。',
    get: (v) => {
      const e = rec(v.embedding).enabled;
      return typeof e === 'boolean' ? e : undefined;
    },
    set: (b, on) => {
      b.embedding = { ...rec(b.embedding), enabled: on };
    },
    dflt: true,
  },
  {
    path: 'memory.bm25.enabled',
    label: 'BM25 通道（bm25）',
    offEffect: '关掉：召回不再走 BM25 关键词通道，只剩向量/FTS 结果。',
    get: (v) => {
      const e = rec(v.bm25).enabled;
      return typeof e === 'boolean' ? e : undefined;
    },
    set: (b, on) => {
      b.bm25 = { ...rec(b.bm25), enabled: on };
    },
    dflt: true,
  },
  {
    path: 'memory.links.enabled',
    label: '记忆关联边（links）',
    offEffect: '关掉：不再建/用记忆之间的关联边，邻居扩展与关系召回失效。',
    get: (v) => {
      const e = rec(v.links).enabled;
      return typeof e === 'boolean' ? e : undefined;
    },
    set: (b, on) => {
      b.links = { ...rec(b.links), enabled: on };
    },
    dflt: true,
  },
];

export function EmergencySwitchesPanel() {
  const { view, reload } = useMemorySettings();
  const [draft, setDraft] = useState<Record<string, boolean> | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!view) return;
    const next: Record<string, boolean> = {};
    for (const g of GATES) next[g.path] = g.get(view) ?? g.dflt;
    setDraft(next);
  }, [view]);

  if (!view || !draft) return <div style={{ padding: 24 }}>加载中…</div>;

  const changed = GATES.filter((g) => {
    const cur = g.get(view) ?? g.dflt;
    return draft[g.path] !== cur;
  });

  const save = async () => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {};
      for (const g of GATES) g.set(body, draft[g.path]);
      await settingsApi.set('memory', body);
      tea.notify.success('已保存应急开关，Core 重启后生效');
      await reload();
    } catch (e) {
      tea.notify.error(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Form>
      <Form.Title>B 应急开关（回滚总闸）</Form.Title>
      <Text parent="div" style={{ marginBottom: 12, fontSize: 12, color: '#8a8f99' }}>
        {CONFIG_TIER_DESC.B}
      </Text>
      <Text parent="div" style={{ marginBottom: 12, fontSize: 12, color: '#e34d59' }}>
        这些是「出问题才动」的开关。关闭会在 Core 重启后生效，且不会删除已有数据；重新打开即恢复。
      </Text>
      {GATES.map((g) => {
        const cur = g.get(view) ?? g.dflt;
        const next = draft[g.path];
        return (
          <Form.Item key={g.path} label={g.label}>
            <div>
              <Checkbox
                value={next}
                disabled={saving}
                onChange={(v) => setDraft({ ...draft, [g.path]: v })}
              >
                {next ? '已开启' : '已关闭'}
                {next !== cur ? '（待保存）' : ''}
              </Checkbox>
              <Tag
                theme={cur === g.dflt ? undefined : 'warning'}
                style={{ marginLeft: 8 }}
              >
                当前生效：{cur ? '开' : '关'}
              </Tag>
              <Text style={HINT_STYLE}>{g.path}</Text>
              <Text style={next ? HINT_STYLE : WARN_STYLE}>{next ? '开启时：按原逻辑工作。' : `关掉后：${g.offEffect}`}</Text>
            </div>
          </Form.Item>
        );
      })}
      <Form.Action>
        <Button
          type="primary"
          disabled={saving || changed.length === 0}
          loading={saving}
          onClick={() => void save()}
        >
          {saving ? '保存中…' : changed.length ? `保存 ${changed.length} 项改动` : '无改动'}
        </Button>
      </Form.Action>
    </Form>
  );
}

// ───────────────────────────── C：校准阈值 ─────────────────────────────

interface CalibDraft {
  ipEnabled: boolean;
  ipPenalty: string;
  worthinessExtraction: boolean;
  lrMode: 'off' | 'shadow' | 'enforce';
  lrKeepRatio: string;
  lrMinPerLayer: string;
  lrLambda: string;
  lrBudgetMs: string;
  injFold: boolean;
  injMaxChars: string;
  injMaxLineChars: string;
}

function toCalibDraft(v: SettingsView): CalibDraft {
  const ip = rec(v.importancePenalty);
  const wo = rec(v.worthiness);
  const lr = rec(v.layerRuler);
  const inj = rec(v.injection);
  const mode = lr.mode === 'shadow' || lr.mode === 'enforce' ? lr.mode : 'off';
  return {
    ipEnabled: bool(ip.enabled),
    ipPenalty: numStr(ip.penalty),
    worthinessExtraction: bool(wo.extractionEnabled),
    lrMode: mode,
    lrKeepRatio: numStr(lr.keepRatio),
    lrMinPerLayer: numStr(lr.minPerLayer),
    lrLambda: numStr(lr.lengthLambda),
    lrBudgetMs: numStr(lr.budgetMs),
    injFold: bool(inj.foldIdentical),
    injMaxChars: inj.maxChars === null ? 'unlimited' : numStr(inj.maxChars),
    injMaxLineChars: inj.maxLineChars === null ? 'unlimited' : numStr(inj.maxLineChars),
  };
}

const isInt = (s: string) => s === '' || /^\d+$/.test(s);
const isDecimal = (s: string) => s === '' || /^\d*\.?\d+$/.test(s);

export function CalibrationPanel() {
  const { view, reload } = useMemorySettings();
  const [draft, setDraft] = useState<CalibDraft | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (view) setDraft(toCalibDraft(view));
  }, [view]);

  if (!view || !draft) return <div style={{ padding: 24 }}>加载中…</div>;

  const valid =
    isDecimal(draft.ipPenalty) &&
    (!draft.ipPenalty || Number(draft.ipPenalty) <= 0.9) &&
    isDecimal(draft.lrKeepRatio) &&
    (!draft.lrKeepRatio || (Number(draft.lrKeepRatio) > 0 && Number(draft.lrKeepRatio) <= 1)) &&
    isInt(draft.lrMinPerLayer) &&
    isDecimal(draft.lrLambda) &&
    (!draft.lrLambda || Number(draft.lrLambda) <= 1) &&
    isInt(draft.lrBudgetMs) &&
    (!draft.lrBudgetMs || Number(draft.lrBudgetMs) >= 50) &&
    (!draft.lrBudgetMs || Number(draft.lrBudgetMs) <= 5000) &&
    isInt(draft.injMaxChars) &&
    isInt(draft.injMaxLineChars);

  const save = async () => {
    setSaving(true);
    try {
      const unlimited = (s: string) => (s === 'unlimited' || s === '' ? null : Number(s));
      const body: Record<string, unknown> = {
        importancePenalty: {
          enabled: draft.ipEnabled,
          ...(draft.ipPenalty.trim() ? { penalty: Number(draft.ipPenalty) } : {}),
        },
        worthiness: { extractionEnabled: draft.worthinessExtraction },
        layerRuler: {
          mode: draft.lrMode,
          ...(draft.lrKeepRatio.trim() ? { keepRatio: Number(draft.lrKeepRatio) } : {}),
          ...(draft.lrMinPerLayer.trim() ? { minPerLayer: Number(draft.lrMinPerLayer) } : {}),
          ...(draft.lrLambda.trim() ? { lengthLambda: Number(draft.lrLambda) } : {}),
          ...(draft.lrBudgetMs.trim() ? { budgetMs: Number(draft.lrBudgetMs) } : {}),
        },
        injection: {
          foldIdentical: draft.injFold,
          maxChars: unlimited(draft.injMaxChars),
          maxLineChars: unlimited(draft.injMaxLineChars),
        },
      };
      await settingsApi.set('memory', body);
      tea.notify.success('已保存校准参数，Core 重启后生效');
      await reload();
    } catch (e) {
      tea.notify.error(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Form>
      <Form.Title>C 校准阈值</Form.Title>
      <Text parent="div" style={{ marginBottom: 12, fontSize: 12, color: '#8a8f99' }}>
        {CONFIG_TIER_DESC.C}
      </Text>
      <Text parent="div" style={{ marginBottom: 12, fontSize: 12, color: '#e34d59' }}>
        改这些数会改变召回质量。没有实验数据（golden 集对照）时保持当前值；改完请记录改动理由与指标。
      </Text>

      <Form.Title>重要度（importancePenalty / worthiness）</Form.Title>
      <Form.Item label="召回降权开关">
        <div>
          <Checkbox
            value={draft.ipEnabled}
            disabled={saving}
            onChange={(v) => setDraft({ ...draft, ipEnabled: v })}
          >
            按重要度给召回结果降权（shadow-first，先观察再强制）
          </Checkbox>
          <Text style={HINT_STYLE}>
            关掉 = 召回完全按相似度排序；开启后低重要度记忆在名次上被压。
          </Text>
        </div>
      </Form.Item>
      <Form.Item label="降权系数 penalty">
        <div>
          <Input
            size="full"
            value={draft.ipPenalty}
            onChange={(v) => setDraft({ ...draft, ipPenalty: v })}
            placeholder="0.3"
            disabled={saving || !draft.ipEnabled}
          />
          <Text style={HINT_STYLE}>范围 0–0.9。越大压得越狠；0.3 是当前生产档。</Text>
        </div>
      </Form.Item>
      <Form.Item label="抽取标注（worthiness.extractionEnabled）">
        <div>
          <Checkbox
            value={draft.worthinessExtraction}
            disabled={saving}
            onChange={(v) => setDraft({ ...draft, worthinessExtraction: v })}
          >
            抽取时写入 worthiness 分值
          </Checkbox>
          <Text style={HINT_STYLE}>
            关掉 = 新写入的记忆没有重要度分值，降权对该批数据不生效。
          </Text>
        </div>
      </Form.Item>

      <Form.Title>选线尺（recall.layerRuler）</Form.Title>
      <Form.Item label="模式">
        <div>
          <Select
            size="full"
            value={draft.lrMode}
            disabled={saving}
            options={[
              { value: 'off', text: 'off：不启用（旧行为）' },
              { value: 'shadow', text: 'shadow：只记录不裁（观察）' },
              { value: 'enforce', text: 'enforce：真按层裁' },
            ]}
            onChange={(v: string) =>
              setDraft({ ...draft, lrMode: v as CalibDraft['lrMode'] })
            }
          />
          <Text style={HINT_STYLE}>回退 = 一行改回 off；shadow 用于上线前对照。</Text>
        </div>
      </Form.Item>
      <Form.Item label="层内保留比例 keepRatio">
        <div>
          <Input
            size="full"
            value={draft.lrKeepRatio}
            onChange={(v) => setDraft({ ...draft, lrKeepRatio: v })}
            placeholder="0.67"
            disabled={saving || draft.lrMode === 'off'}
          />
          <Text style={HINT_STYLE}>(0,1]。0.67 = 每层保留约三分之二；压缩主要来自地板，不是这个比例。</Text>
        </div>
      </Form.Item>
      <Form.Item label="每层下限 minPerLayer">
        <div>
          <Input
            size="full"
            value={draft.lrMinPerLayer}
            onChange={(v) => setDraft({ ...draft, lrMinPerLayer: v })}
            placeholder="1"
            disabled={saving || draft.lrMode === 'off'}
          />
          <Text style={HINT_STYLE}>≥1。名次切之前每层至少留几条。</Text>
        </div>
      </Form.Item>
      <Form.Item label="长度折扣 lengthLambda">
        <div>
          <Input
            size="full"
            value={draft.lrLambda}
            onChange={(v) => setDraft({ ...draft, lrLambda: v })}
            placeholder="0（纯余弦）"
            disabled={saving || draft.lrMode === 'off'}
          />
          <Text style={HINT_STYLE}>
            [0,1]。实测 0.06 把长「批次总结」压到短事实之下；不改判定，只改层内名次。
          </Text>
        </div>
      </Form.Item>
      <Form.Item label="选线预算 budgetMs">
        <div>
          <Input
            size="full"
            value={draft.lrBudgetMs}
            onChange={(v) => setDraft({ ...draft, lrBudgetMs: v })}
            placeholder="800（生产）"
            disabled={saving || draft.lrMode === 'off'}
          />
          <Text style={HINT_STYLE}>
            50–5000ms。超时则整段退回原序截断；远端 embedding RTT 偏高时必须给足（生产 800）。
          </Text>
        </div>
      </Form.Item>

      <Form.Title>注入装配（recall.injection）</Form.Title>
      <Form.Item label="折叠重复行 foldIdentical">
        <div>
          <Checkbox
            value={draft.injFold}
            disabled={saving}
            onChange={(v) => setDraft({ ...draft, injFold: v })}
          >
            同会话相邻回合注入行逐字节相同 → 折叠为 0 行
          </Checkbox>
          <Text style={HINT_STYLE}>省预算；关掉 = 每轮都原样注入。</Text>
        </div>
      </Form.Item>
      <Form.Item label="总字符预算 maxChars">
        <div>
          <Input
            size="full"
            value={draft.injMaxChars}
            onChange={(v) => setDraft({ ...draft, injMaxChars: v })}
            placeholder="6000 或 unlimited"
            disabled={saving}
          />
          <Text style={HINT_STYLE}>
            缺省 6000（标准档）。填 unlimited 表示不限；填数字为字符上限，装不下的按名次丢弃。
          </Text>
        </div>
      </Form.Item>
      <Form.Item label="单行上限 maxLineChars">
        <div>
          <Input
            size="full"
            value={draft.injMaxLineChars}
            onChange={(v) => setDraft({ ...draft, injMaxLineChars: v })}
            placeholder="unlimited"
            disabled={saving}
          />
          <Text style={HINT_STYLE}>null/unlimited = 不截断；数字按句界收口，截断不改判定。</Text>
        </div>
      </Form.Item>

      <Form.Action>
        <Button type="primary" disabled={!valid || saving} loading={saving} onClick={() => void save()}>
          {saving ? '保存中…' : '保存校准参数'}
        </Button>
      </Form.Action>
    </Form>
  );
}

// ───────────────────────────── D：常量清单（只读） ─────────────────────────────

export function ConstantsPanel() {
  const [q, setQ] = useState('');
  const [tier, setTier] = useState<'all' | ConfigTier>('all');
  const rows = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return CONFIG_CATALOG.filter(
      (e) =>
        (tier === 'all' || e.tier === tier) &&
        (!kw ||
          e.path.toLowerCase().includes(kw) ||
          e.meaning.toLowerCase().includes(kw) ||
          e.type.toLowerCase().includes(kw)),
    );
  }, [q, tier]);
  const shown = rows.slice(0, 300);

  return (
    <div>
      <Form.Title>D 常量清单（只读）</Form.Title>
      <Text parent="div" style={{ marginBottom: 8, fontSize: 12, color: '#8a8f99' }}>
        {CONFIG_TIER_DESC.D}
      </Text>
      <Text parent="div" style={{ marginBottom: 12, fontSize: 12, color: '#e34d59' }}>
        本页只展示、不可改：这些键在模板里保留是为了审计与溯源；要改请走代码评审，不要在生产 override 里改。
      </Text>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 260px', minWidth: 220 }}>
          <Input
            size="full"
            value={q}
            onChange={setQ}
            placeholder="搜索键名 / 类型 / 意义，例如 timeout、soul、embedding"
          />
        </div>
        <div style={{ width: 180 }}>
          <Select
            size="full"
            value={tier}
            options={[
              { value: 'all', text: '全部档位' },
              { value: 'A', text: 'A 部署与凭据' },
              { value: 'B', text: 'B 应急开关' },
              { value: 'C', text: 'C 校准阈值' },
              { value: 'D', text: 'D 常量' },
            ]}
            onChange={(v: string) => setTier(v as 'all' | ConfigTier)}
          />
        </div>
      </div>
      <Text parent="div" style={{ marginBottom: 8, fontSize: 12, color: '#8a8f99' }}>
        共 {rows.length} 条匹配（当前显示前 {shown.length} 条；清单总计 {CONFIG_CATALOG.length} 条）。
      </Text>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: '#f5f6f8', textAlign: 'left' }}>
              <th style={TH}>档位</th>
              <th style={TH}>配置键</th>
              <th style={TH}>类型</th>
              <th style={TH}>缺省</th>
              <th style={TH}>意义</th>
              <th style={TH}>解析点</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((e) => (
              <tr key={e.path} style={{ borderTop: '1px solid #eceef1' }}>
                <td style={TD}>
                  <Tag theme={e.tier === 'D' ? undefined : 'warning'}>{e.tier}</Tag>
                </td>
                <td style={{ ...TD, fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{e.path}</td>
                <td style={{ ...TD, whiteSpace: 'nowrap' }}>{e.type || '—'}</td>
                <td style={{ ...TD, whiteSpace: 'nowrap' }}>{e.def || '—'}</td>
                <td style={TD}>{e.meaning || <span style={{ color: '#b0b4bb' }}>未采集</span>}</td>
                <td style={{ ...TD, fontFamily: 'monospace', whiteSpace: 'nowrap', color: '#8a8f99' }}>
                  {e.source}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const TH = { padding: '8px 10px', fontWeight: 600, color: '#5c6270', whiteSpace: 'nowrap' } as const;
const TD = { padding: '8px 10px', verticalAlign: 'top' } as const;
