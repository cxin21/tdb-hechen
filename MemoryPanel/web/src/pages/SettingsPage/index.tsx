/**
 * SettingsPage — 管理员设置（spec §4 / §9.3）。
 *
 * 三个页签：Wiki 设置（MemoryKnowledge）/ Memory 设置（MemoryCore）/ Proxy 计费（MemoryProxy）。
 * 仅全局 admin 可见/可用（useCurrentRole() === 'admin'，路由与侧边导航两处都做门控）。
 * apiKey 输入框留空 = 保留原值；placeholder 显示尾 4 位掩码。
 * 保存成功提示「重启后生效」；embedding 变更追加重建警示；rebuildStatus 以 Tag 展示。
 * Proxy 计费为整表热生效（下一请求生效，无需重启）。
 *
 * 组件适配说明（行为契约不变，API 以项目内 tea-component 真实签名为准）：
 *   - Tabs 面板用 <TabPanel id="…">（tea-component 无 Tabs.Tab）；
 *   - Tag 用 theme="success|warning|error"（无 type / "danger"）；
 *   - toast 走 lib/tea-bridge 的 tea.notify（项目未挂载 sonner <Toaster>，sonner toast 不显示）；
 *   - load 失败 try/catch → tea.notify.error（与现有页面错误提示范式一致）。
 */
import { useCallback, useEffect, useState } from 'react';
import { Tabs, TabPanel, Form, Input, Button, Tag } from 'tea-component';
import {
  settingsApi,
  proxyPricingApi,
  type SettingsTarget,
  type SettingsView,
  type PricingEntry,
  type PricingView,
} from '@/lib/api/settings';
import { useCurrentRole } from '@/services';
import { tea } from '@/lib/tea-bridge';

type Draft = {
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  llmMaxTokens: string;
  llmTimeoutMs: string;
  embBaseUrl: string;
  embApiKey: string;
  embModel: string;
  embDimensions: string;
};

function toDraft(v: SettingsView): Draft {
  return {
    llmBaseUrl: v.llm.baseUrl ?? '',
    llmApiKey: '',
    llmModel: v.llm.model ?? '',
    llmMaxTokens: v.llm.maxTokens != null ? String(v.llm.maxTokens) : '',
    llmTimeoutMs: v.llm.timeoutMs != null ? String(v.llm.timeoutMs) : '',
    embBaseUrl: v.embedding.baseUrl ?? '',
    embApiKey: '',
    embModel: v.embedding.model ?? '',
    embDimensions: v.embedding.dimensions != null ? String(v.embedding.dimensions) : '',
  };
}

function ServiceSettingsPanel({ target, label }: { target: SettingsTarget; label: string }) {
  const [view, setView] = useState<SettingsView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const v = await settingsApi.get(target);
      setView(v);
      setDraft(toDraft(v));
    } catch (e) {
      tea.notify.error(e);
    }
  }, [target]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!view || !draft) return <div style={{ padding: 24 }}>加载中…</div>;
  const rs = view.rebuildStatus;

  const save = async () => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        llm: {
          baseUrl: draft.llmBaseUrl,
          model: draft.llmModel,
          // apiKey 留空 = 不传字段 = 服务端保留原值
          ...(draft.llmApiKey ? { apiKey: draft.llmApiKey } : {}),
          ...(draft.llmMaxTokens ? { maxTokens: Number(draft.llmMaxTokens) } : {}),
          ...(draft.llmTimeoutMs ? { timeoutMs: Number(draft.llmTimeoutMs) } : {}),
        },
        embedding: {
          baseUrl: draft.embBaseUrl,
          model: draft.embModel,
          ...(draft.embApiKey ? { apiKey: draft.embApiKey } : {}),
          ...(draft.embDimensions ? { dimensions: Number(draft.embDimensions) } : {}),
        },
      };
      const res = await settingsApi.set(target, body);
      if (res.embeddingChanged) {
        tea.notify.warning('已保存。重启服务后将自动重建向量索引；重建期间向量召回降级为纯 FTS，完成后自动恢复。');
      } else {
        tea.notify.success('已保存，重启服务后生效');
      }
      await load();
    } catch (e) {
      tea.notify.error(e);
    } finally {
      setSaving(false);
    }
  };

  // 数字字段：空 = 不修改；非空必须为纯数字（正整数）
  const num = (v: string) => !v || /^\d+$/.test(v);
  const valid =
    num(draft.llmMaxTokens) &&
    num(draft.llmTimeoutMs) &&
    num(draft.embDimensions) &&
    /^https?:\/\/.+$/.test(draft.llmBaseUrl) &&
    /^https?:\/\/.+$/.test(draft.embBaseUrl) &&
    draft.llmModel.trim() !== '' &&
    draft.embModel.trim() !== '';

  const triggerRevectorize = () => {
    void settingsApi
      .revectorize(target)
      .then(() => tea.notify.success('已触发重建'))
      .catch((e) => tea.notify.error(e));
  };

  return (
    <Form>
      <Form.Title>LLM（{label}）</Form.Title>
      <Form.Item label="Base URL">
        <Input
          size="full"
          value={draft.llmBaseUrl}
          onChange={(v) => setDraft({ ...draft, llmBaseUrl: v })}
          placeholder="https://…"
          disabled={saving}
        />
      </Form.Item>
      <Form.Item label="API Key">
        <Input
          size="full"
          value={draft.llmApiKey}
          onChange={(v) => setDraft({ ...draft, llmApiKey: v })}
          placeholder={
            view.llm.hasApiKey
              ? `已配置（尾 4 位：${view.llm.apiKeyMasked.slice(-4)}），留空保留原值`
              : '未配置'
          }
          autoComplete="new-password"
          disabled={saving}
        />
      </Form.Item>
      <Form.Item label="Model">
        <Input
          size="full"
          value={draft.llmModel}
          onChange={(v) => setDraft({ ...draft, llmModel: v })}
          disabled={saving}
        />
      </Form.Item>
      <Form.Item label="Max Tokens">
        <Input
          size="full"
          value={draft.llmMaxTokens}
          onChange={(v) => setDraft({ ...draft, llmMaxTokens: v })}
          disabled={saving}
        />
      </Form.Item>
      <Form.Item label="Timeout (ms)">
        <Input
          size="full"
          value={draft.llmTimeoutMs}
          onChange={(v) => setDraft({ ...draft, llmTimeoutMs: v })}
          disabled={saving}
        />
      </Form.Item>

      <Form.Title>Embedding（{label}）</Form.Title>
      <Form.Item label="Base URL">
        <Input
          size="full"
          value={draft.embBaseUrl}
          onChange={(v) => setDraft({ ...draft, embBaseUrl: v })}
          placeholder="https://…"
          disabled={saving}
        />
      </Form.Item>
      <Form.Item label="API Key">
        <Input
          size="full"
          value={draft.embApiKey}
          onChange={(v) => setDraft({ ...draft, embApiKey: v })}
          placeholder={
            view.embedding.hasApiKey
              ? `已配置（尾 4 位：${view.embedding.apiKeyMasked.slice(-4)}），留空保留原值`
              : '未配置'
          }
          autoComplete="new-password"
          disabled={saving}
        />
      </Form.Item>
      <Form.Item label="Model">
        <Input
          size="full"
          value={draft.embModel}
          onChange={(v) => setDraft({ ...draft, embModel: v })}
          disabled={saving}
        />
      </Form.Item>
      <Form.Item label="Dimensions">
        <Input
          size="full"
          value={draft.embDimensions}
          onChange={(v) => setDraft({ ...draft, embDimensions: v })}
          disabled={saving}
        />
      </Form.Item>

      <Form.Action>
        <Button type="primary" disabled={!valid || saving} loading={saving} onClick={() => void save()}>
          {saving ? '保存中…' : '保存'}
        </Button>
        {rs && rs.status !== 'idle' && (
          <Tag theme={rs.status === 'failed' ? 'error' : rs.status === 'running' ? 'warning' : 'success'}>
            向量重建：{rs.status}
            {rs.reason ? `（${rs.reason}）` : ''}
          </Tag>
        )}
        {target === 'knowledge' && rs && (rs.status === 'failed' || rs.status === 'done') && (
          <Button onClick={triggerRevectorize}>重建向量索引</Button>
        )}
      </Form.Action>
    </Form>
  );
}

const PRICE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'] as const;

/** Proxy 计费价目表（spec §9.3）：可编辑行表格（增/删/改行 + 整表保存，热生效）。 */
function ProxyPricingPanel() {
  const [view, setView] = useState<PricingView | null>(null);
  const [rows, setRows] = useState<PricingEntry[]>([]);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const v = await proxyPricingApi.get();
      setView(v);
      setRows(v.models);
    } catch (e) {
      tea.notify.error(e);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setRow = (i: number, patch: Partial<PricingEntry>) =>
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const save = async () => {
    setSaving(true);
    try {
      const v = await proxyPricingApi.set(rows);
      setView(v);
      setRows(v.models);
      tea.notify.success('已保存，下一请求生效');
    } catch (e) {
      tea.notify.error(e);
    } finally {
      setSaving(false);
    }
  };

  if (!view) return <div style={{ padding: 24 }}>加载中…</div>;

  const addRow = () =>
    setRows([
      ...rows,
      { name: '', modelName: '', input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    ]);

  return (
    <Form>
      <Form.Title>计费价目表（source: {view.source}）</Form.Title>
      <div style={{ display: 'grid', gap: 8, padding: '0 0 12px' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr repeat(5, 100px) auto',
            gap: 8,
            fontWeight: 600,
          }}
        >
          <span>model_id</span>
          <span>展示名</span>
          {PRICE_FIELDS.map((f) => (
            <span key={f}>{f}</span>
          ))}
          <span />
        </div>
        {rows.map((r, i) => (
          <div
            key={i}
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr repeat(5, 100px) auto',
              gap: 8,
              alignItems: 'center',
            }}
          >
            <Input
              value={r.name}
              onChange={(v) => setRow(i, { name: v })}
              placeholder="model_id"
              disabled={saving}
            />
            <Input
              value={r.modelName}
              onChange={(v) => setRow(i, { modelName: v })}
              placeholder="展示名"
              disabled={saving}
            />
            {PRICE_FIELDS.map((f) => (
              <Input
                key={f}
                value={String(r[f])}
                onChange={(v) => setRow(i, { [f]: Number(v) } as Partial<PricingEntry>)}
                disabled={saving}
              />
            ))}
            <Button
              onClick={() => setRows((prev) => prev.filter((_, idx) => idx !== i))}
              disabled={saving}
            >
              删除
            </Button>
          </div>
        ))}
      </div>
      <Form.Action>
        <Button onClick={addRow} disabled={saving}>
          新增行
        </Button>
        <Button type="primary" disabled={saving} loading={saving} onClick={() => void save()}>
          {saving ? '保存中…' : '保存'}
        </Button>
      </Form.Action>
    </Form>
  );
}

export function SettingsPage() {
  const role = useCurrentRole();
  if (role !== 'admin') return <div style={{ padding: 24 }}>仅管理员可访问设置页</div>;
  return (
    <div style={{ padding: 16 }}>
      <Tabs
        tabs={[
          { id: 'knowledge', label: 'Wiki 设置' },
          { id: 'memory', label: 'Memory 设置' },
          { id: 'pricing', label: 'Proxy 计费' },
        ]}
      >
        <TabPanel id="knowledge">
          <ServiceSettingsPanel target="knowledge" label="MemoryKnowledge" />
        </TabPanel>
        <TabPanel id="memory">
          <ServiceSettingsPanel target="memory" label="MemoryCore" />
        </TabPanel>
        <TabPanel id="pricing">
          <ProxyPricingPanel />
        </TabPanel>
      </Tabs>
    </div>
  );
}
