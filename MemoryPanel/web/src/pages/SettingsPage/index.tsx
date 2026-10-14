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
import { useTranslation } from 'react-i18next';
import { Tabs, TabPanel, Form, Input, Button, Tag, Checkbox, Select, Text } from 'tea-component';
import {
  settingsApi,
  rerankModelApi,
  proxyPricingApi,
  type SettingsTarget,
  type SettingsView,
  type PricingEntry,
  type PricingView,
  type RerankModelStatus,
} from '@/lib/api/settings';
import { useCurrentRole } from '@/services';
import { tea } from '@/lib/tea-bridge';

type RerankProvider = 'siliconflow' | 'dashscope' | 'local' | 'none';

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
  // rerank（P1 task-4，仅 memory 目标）
  rkEnabled: boolean;
  rkProvider: RerankProvider;
  rkApiKey: string;
  rkBaseUrl: string;
  rkModel: string;
  rkTimeoutMs: string;
  rkCandidates: string;
  rkMinScore: string;
  rkLocalModelDir: string;
  rkIdleUnloadMs: string;
  // 重要度（P1 task-7，仅 memory 目标）：worthiness.extractionEnabled + recall.importancePenalty
  wExtractionEnabled: boolean;
  ipEnabled: boolean;
  ipPenalty: string;
};

function fmtBytes(n?: number): string {
  if (n == null) return '—';
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(2)} GB`;
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

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
    rkEnabled: v.rerank?.enabled ?? false,
    rkProvider: v.rerank?.provider ?? 'none',
    rkApiKey: '',
    rkBaseUrl: v.rerank?.baseUrl ?? '',
    rkModel: v.rerank?.model ?? '',
    rkTimeoutMs: v.rerank?.timeoutMs != null ? String(v.rerank.timeoutMs) : '',
    rkCandidates: v.rerank?.candidates != null ? String(v.rerank.candidates) : '',
    rkMinScore: v.rerank?.minScore != null ? String(v.rerank.minScore) : '',
    rkLocalModelDir: v.rerank?.local?.modelDir ?? '',
    rkIdleUnloadMs: v.rerank?.local?.idleUnloadMs != null ? String(v.rerank.local.idleUnloadMs) : '',
    wExtractionEnabled: v.worthiness?.extractionEnabled ?? false,
    ipEnabled: v.importancePenalty?.enabled ?? false,
    ipPenalty: v.importancePenalty?.penalty != null ? String(v.importancePenalty.penalty) : '',
  };
}

function ServiceSettingsPanel({ target, label }: { target: SettingsTarget; label: string }) {
  const { t } = useTranslation();
  const [view, setView] = useState<SettingsView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [rerankDl, setRerankDl] = useState<RerankModelStatus | null>(null);
  const isMemory = target === 'memory';
  const localTier = isMemory && draft?.rkProvider === 'local';

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

  // Rerank 本地模型状态轮询（P1 task-4）：panel 无推送通道（spec §4.4），
  // local 档可见时 1s 轮询 /api/v1/rerank-model/status；下载进度由 Core 侧
  // 计数器节流发布（downloader.ts maybePublishFromCounter）驱动平滑刷新。
  useEffect(() => {
    if (!localTier) return;
    let stopped = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const s = await rerankModelApi.status();
        if (!stopped) setRerankDl(s);
      } catch {
        // 轮询失败静默（网络抖动/服务重启中），下一 tick 重试
      }
      if (!stopped) timer = window.setTimeout(() => void tick(), 1000);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
      // 审稿 M3：离开 local 档即丢弃下载状态，防止切回时短暂复显 stale 进度
      setRerankDl(null);
    };
  }, [localTier]);

  if (!view || !draft) return <div style={{ padding: 24 }}>加载中…</div>;
  const rs = view.rebuildStatus;

  const triggerRerankDownload = () => {
    rerankModelApi
      .download()
      .then(setRerankDl)
      .catch((e) => tea.notify.error(e));
  };

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
        // rerank（仅 memory 目标；P1 task-4）：apiKey 留空 = 保留原值；
        // 按 provider 显隐字段 —— 云端传 baseUrl/model/超时/候选数/最低分，
        // local 只传 modelDir/idleUnloadMs（服务端 validateOverride 同款语义）。
        ...(isMemory
          ? {
              rerank: {
                enabled: draft.rkEnabled,
                provider: draft.rkProvider,
                ...(draft.rkProvider === 'siliconflow' || draft.rkProvider === 'dashscope'
                  ? {
                      // 审稿 C1/M2：'' = 用服务端 provider 缺省（spec §4.3）——空白键必须省略
                      // 而非发送空串（settings-override HTTP_URL_RE/model 校验会 400）。
                      ...(draft.rkBaseUrl.trim() ? { baseUrl: draft.rkBaseUrl.trim() } : {}),
                      ...(draft.rkModel.trim() ? { model: draft.rkModel.trim() } : {}),
                      ...(draft.rkApiKey ? { apiKey: draft.rkApiKey } : {}),
                      ...(draft.rkTimeoutMs ? { timeoutMs: Number(draft.rkTimeoutMs) } : {}),
                      ...(draft.rkCandidates ? { candidates: Number(draft.rkCandidates) } : {}),
                      ...(draft.rkMinScore !== '' ? { minScore: Number(draft.rkMinScore) } : {}),
                    }
                  : {}),
                ...(draft.rkProvider === 'local'
                  ? {
                      local: {
                        modelDir: draft.rkLocalModelDir,
                        ...(draft.rkIdleUnloadMs ? { idleUnloadMs: Number(draft.rkIdleUnloadMs) } : {}),
                      },
                    }
                  : {}),
              },
              // 重要度（P1 task-7）：penalty 留空 = 保留原值（服务端缺省 0.3）；
              // 形状校验在 validateOverride，[0,0.9] clamp 在 parseConfig。
              importancePenalty: {
                enabled: draft.ipEnabled,
                ...(draft.ipPenalty.trim() ? { penalty: Number(draft.ipPenalty) } : {}),
              },
              worthiness: {
                extractionEnabled: draft.wExtractionEnabled,
              },
            }
          : {}),
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
  // 正整数变体（审稿 M1：0 会被服务端 parseConfig clamp/拒绝——timeoutMs/candidates 均 >0）
  const numPos = (v: string) => !v || (/^\d+$/.test(v) && Number(v) > 0);
  // minScore 允许负数/小数（缺省 -2.0）
  const decimal = (v: string) => !v || /^-?\d+(\.\d+)?$/.test(v);
  // P1-T7：penalty 允许小数且 ≤ 0.9（服务端 clamp [0,0.9]；越界直接拦）
  const ipPenaltyValid =
    !draft.ipPenalty || (/^\d*\.?\d+$/.test(draft.ipPenalty) && Number(draft.ipPenalty) <= 0.9);
  const rerankCloud = isMemory && (draft.rkProvider === 'siliconflow' || draft.rkProvider === 'dashscope');
  const rerankLocal = isMemory && draft.rkProvider === 'local';
  // 云端 + 启用但无 key（新输入且服务端也没有）→ 与 parseConfig「云端缺 apiKey =
  // configError + enabled 强制 false」语义对齐，保存前拦截
  const rerankNeedsApiKey = rerankCloud && draft.rkEnabled && !draft.rkApiKey && !view.rerank?.hasApiKey;
  const valid =
    num(draft.llmMaxTokens) &&
    num(draft.llmTimeoutMs) &&
    num(draft.embDimensions) &&
    /^https?:\/\/.+$/.test(draft.llmBaseUrl) &&
    /^https?:\/\/.+$/.test(draft.embBaseUrl) &&
    draft.llmModel.trim() !== '' &&
    draft.embModel.trim() !== '' &&
    (!isMemory ||
      ((rerankCloud
        ? numPos(draft.rkTimeoutMs) &&
          numPos(draft.rkCandidates) &&
          decimal(draft.rkMinScore) &&
          (!draft.rkBaseUrl || /^https?:\/\/.+$/.test(draft.rkBaseUrl))
        : true) &&
        (rerankLocal ? num(draft.rkIdleUnloadMs) : true) &&
        ipPenaltyValid &&
        !rerankNeedsApiKey));

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

      {isMemory && (
        <>
          <Form.Title>{t('settings.rerank.title', { label })}</Form.Title>
          {view.rerank?.configError ? (
            <Form.Item label={t('settings.rerank.configError')}>
              <Tag theme="error">{view.rerank.configError}</Tag>
            </Form.Item>
          ) : null}
          <Form.Item label={t('settings.rerank.enabled')}>
            <div>
              <Checkbox value={draft.rkEnabled} disabled={saving} onChange={(v) => setDraft({ ...draft, rkEnabled: v })}>
                {t('settings.rerank.enabled')}
              </Checkbox>
              <Text style={{ display: 'block', marginTop: 4, fontSize: 12, color: '#8a8f99' }}>
                {t('settings.rerank.activeNote')}
              </Text>
            </div>
          </Form.Item>
          <Form.Item label={t('settings.rerank.provider')}>
            <Select
              size="full"
              value={draft.rkProvider}
              disabled={saving}
              options={[
                { value: 'siliconflow', text: t('settings.rerank.provider.siliconflow') },
                { value: 'dashscope', text: t('settings.rerank.provider.dashscope') },
                { value: 'local', text: t('settings.rerank.provider.local') },
                { value: 'none', text: t('settings.rerank.provider.none') },
              ]}
              onChange={(v: string) => setDraft({ ...draft, rkProvider: v as RerankProvider })}
            />
          </Form.Item>
          {rerankCloud && (
            <>
              <Form.Item label={t('settings.rerank.baseUrl')}>
                <Input
                  size="full"
                  value={draft.rkBaseUrl}
                  onChange={(v) => setDraft({ ...draft, rkBaseUrl: v })}
                  placeholder={draft.rkProvider === 'siliconflow' ? 'https://api.siliconflow.cn' : 'https://dashscope.aliyuncs.com'}
                  disabled={saving}
                />
              </Form.Item>
              <Form.Item label={t('settings.rerank.apiKey')}>
                <Input
                  size="full"
                  value={draft.rkApiKey}
                  onChange={(v) => setDraft({ ...draft, rkApiKey: v })}
                  placeholder={
                    view.rerank?.hasApiKey
                      ? t('settings.rerank.apiKey.masked', { masked: view.rerank.apiKeyMasked.slice(-4) })
                      : t('settings.rerank.apiKey.unset')
                  }
                  autoComplete="new-password"
                  disabled={saving}
                />
              </Form.Item>
              <Form.Item label={t('settings.rerank.model')}>
                <Input
                  size="full"
                  value={draft.rkModel}
                  onChange={(v) => setDraft({ ...draft, rkModel: v })}
                  placeholder={draft.rkProvider === 'siliconflow' ? 'Qwen/Qwen3-Reranker-0.6B' : 'qwen3-rerank'}
                  disabled={saving}
                />
              </Form.Item>
              <Form.Item label={t('settings.rerank.timeoutMs')}>
                <Input size="full" value={draft.rkTimeoutMs} onChange={(v) => setDraft({ ...draft, rkTimeoutMs: v })} disabled={saving} />
              </Form.Item>
              <Form.Item label={t('settings.rerank.candidates')}>
                <Input size="full" value={draft.rkCandidates} onChange={(v) => setDraft({ ...draft, rkCandidates: v })} disabled={saving} />
              </Form.Item>
              <Form.Item label={t('settings.rerank.minScore')}>
                <Input size="full" value={draft.rkMinScore} onChange={(v) => setDraft({ ...draft, rkMinScore: v })} disabled={saving} />
              </Form.Item>
            </>
          )}
          {rerankLocal && (
            <>
              <Form.Item label={t('settings.rerank.local.modelDir')}>
                <Input
                  size="full"
                  value={draft.rkLocalModelDir}
                  onChange={(v) => setDraft({ ...draft, rkLocalModelDir: v })}
                  placeholder={t('settings.rerank.local.modelDir.placeholder')}
                  disabled={saving}
                />
              </Form.Item>
              <Form.Item label={t('settings.rerank.local.idleUnloadMs')}>
                <div>
                  <Input
                    size="full"
                    value={draft.rkIdleUnloadMs}
                    onChange={(v) => setDraft({ ...draft, rkIdleUnloadMs: v })}
                    disabled={saving}
                  />
                  <Text style={{ display: 'block', marginTop: 4, fontSize: 12, color: '#8a8f99' }}>
                    {t('settings.rerank.local.idleUnloadMs.hint')}
                  </Text>
                </div>
              </Form.Item>
              <Form.Item label={t('settings.rerank.local.status')}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <Button
                    disabled={rerankDl?.state === 'downloading'}
                    loading={rerankDl?.state === 'downloading'}
                    onClick={triggerRerankDownload}
                  >
                    {rerankDl?.state === 'downloading'
                      ? t('settings.rerank.local.downloading', { percent: rerankDl.percent })
                      : t('settings.rerank.local.download')}
                  </Button>
                  {rerankDl === null ? (
                    <Tag>{t('settings.rerank.local.statusUnknown')}</Tag>
                  ) : rerankDl.state === 'ready' ? (
                    <Tag theme="success">{t('settings.rerank.local.ready')}</Tag>
                  ) : rerankDl.state === 'downloading' ? (
                    <Tag theme="warning">{`${rerankDl.percent}%`}</Tag>
                  ) : rerankDl.state === 'failed' ? (
                    <Tag theme="error">{t('settings.rerank.local.failed')}</Tag>
                  ) : (
                    <Tag>{t('settings.rerank.local.idle')}</Tag>
                  )}
                </div>
                {rerankDl?.state === 'downloading' &&
                  (() => {
                    const active =
                      rerankDl.files.find((f) => f.state === 'downloading') ??
                      rerankDl.files.find((f) => f.bytesReceived != null && f.bytesReceived < (f.totalBytes ?? Infinity));
                    return active ? (
                      <Text style={{ display: 'block', marginTop: 4, fontSize: 12, color: '#8a8f99' }}>
                        {`${active.rel}：${fmtBytes(active.bytesReceived)} / ${fmtBytes(active.totalBytes)}`}
                      </Text>
                    ) : null;
                  })()}
                {rerankDl?.state === 'failed' && rerankDl.error ? (
                  <Text style={{ display: 'block', marginTop: 4, fontSize: 12, color: '#e34d59' }}>{rerankDl.error}</Text>
                ) : null}
              </Form.Item>
            </>
          )}

          {/* 重要度（P1 task-7）：抽取标注 + 召回降权（shadow-first） */}
          <Form.Title>{t('settings.importance.title')}</Form.Title>
          <Form.Item label={t('settings.importance.extraction')}>
            <div>
              <Checkbox
                value={draft.wExtractionEnabled}
                onChange={(v) => setDraft({ ...draft, wExtractionEnabled: v })}
                disabled={saving}
              >
                {t('settings.importance.extraction.label')}
              </Checkbox>
              <Text style={{ display: 'block', marginTop: 4, fontSize: 12, color: '#8a8f99' }}>
                {t('settings.importance.extraction.hint')}
              </Text>
            </div>
          </Form.Item>
          <Form.Item label={t('settings.importance.penalty.enabled')}>
            <div>
              <Checkbox
                value={draft.ipEnabled}
                onChange={(v) => setDraft({ ...draft, ipEnabled: v })}
                disabled={saving}
              >
                {t('settings.importance.penalty.enabled.label')}
              </Checkbox>
              <Text style={{ display: 'block', marginTop: 4, fontSize: 12, color: '#8a8f99' }}>
                {t('settings.importance.penalty.enabled.hint')}
              </Text>
            </div>
          </Form.Item>
          {draft.ipEnabled && (
            <>
              <Form.Item label={t('settings.importance.penalty.value')}>
                <div>
                  <Input
                    size="full"
                    value={draft.ipPenalty}
                    onChange={(v) => setDraft({ ...draft, ipPenalty: v })}
                    placeholder="0.3"
                    disabled={saving}
                  />
                  <Text style={{ display: 'block', marginTop: 4, fontSize: 12, color: '#8a8f99' }}>
                    {t('settings.importance.penalty.value.hint')}
                  </Text>
                </div>
              </Form.Item>
            </>
          )}
        </>
      )}

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
