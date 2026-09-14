/**
 * ProviderEditor — 单个 subject（当前用户 或 属于该用户的某个 Agent）的 LLM Provider 配置。
 *
 * 数据源：`provider`（来自 GET scope=me，可能为 null = 未配置）。
 * 这个组件自持 form 草稿态；保存/清除成功后回调 `onChanged`，由父组件触发刷新。
 * apiKey 一律用 password 输入，不显示明文（跟随面板 API Key 页的密钥展示约定）。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Card, Form, Input, Text } from 'tea-component';
import type { LlmProviderConfig, LlmProviderSubjectType } from '@/lib/api/llm-providers';
import { llmProviderApi } from '@/lib/api/llm-providers';
import { tea } from '@/lib/tea-bridge';

interface ProviderEditorProps {
  title: string;
  /** 二级说明，如 agent 的 ID。 */
  caption?: string;
  subjectType: LlmProviderSubjectType;
  subjectId: string;
  provider: LlmProviderConfig | null;
  /** chip / subtitle 内是否标注 "(你)"。 */
  isYou?: boolean;
  /**
   * 仅对 agent 卡有效:当该 agent 未配 provider 时,当前登录用户是否已设了 user 级默认。
   * 用于正确提示回落:agent 未配 → 先沿用「我的默认」,若我也未设 → 团队/全局默认。
   */
  fallbackUserDefault?: boolean;
  /** 保存或清除成功后触发（父组件 reload scope=me）。 */
  onChanged: () => void;
}

function isValidHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export default function ProviderEditor(props: ProviderEditorProps) {
  const { t } = useTranslation();
  const { title, caption, subjectType, subjectId, provider, isYou, fallbackUserDefault, onChanged } = props;

  // 未配置提示:agent 卡未配且用户已设了默认 → "将沿用我的默认";否则(用户卡、或 agent 无用户级默认)→ "走团队/全局默认"。
  const notConfiguredNote =
    subjectType === 'agent' && fallbackUserDefault
      ? t('llmProvider.notConfigured.userDefault')
      : t('llmProvider.notConfigured');

  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [saving, setSaving] = useState(false);

  const enterEdit = () => {
    setUrl(provider?.url ?? '');
    setApiKey(provider?.apiKey ?? '');
    setModel(provider?.model ?? '');
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setUrl('');
    setApiKey('');
    setModel('');
  };

  const handleSave = async () => {
    const trimmedUrl = url.trim();
    const trimmedApiKey = apiKey.trim();
    const trimmedModel = model.trim();
    if (!isValidHttpUrl(trimmedUrl)) {
      tea.notify.error(t('llmProvider.url.invalid'));
      return;
    }
    if (!trimmedApiKey) {
      tea.notify.error(t('llmProvider.apiKey.required'));
      return;
    }
    if (!trimmedModel) {
      tea.notify.error(t('llmProvider.model.required'));
      return;
    }
    setSaving(true);
    try {
      await llmProviderApi.save({
        subjectType,
        subjectId,
        url: trimmedUrl,
        apiKey: trimmedApiKey,
        model: trimmedModel,
      });
      tea.notify.success(t('llmProvider.notify.saved'));
      setEditing(false);
      onChanged();
    } catch (e) {
      tea.notify.error(e);
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    const ok = await tea.confirm({
      message: t('llmProvider.confirm.clear'),
      description: t('llmProvider.confirm.clear.desc'),
      okText: t('llmProvider.clear'),
    });
    if (!ok) return;
    try {
      await llmProviderApi.clear(subjectType, subjectId);
      tea.notify.success(t('llmProvider.notify.cleared'));
      setEditing(false);
      onChanged();
    } catch (e) {
      tea.notify.error(e);
    }
  };

  return (
    <Card className="_llm-provider-card">
      <Card.Body
        className="_llm-provider-card-body"
        title={
          <span>
            {title}
            {isYou ? ` ${t('common.you')}` : ''}
          </span>
        }
      >
        {caption ? (
          <Text theme="weak" parent="div" style={{ fontSize: 11, marginBottom: 8 }}>
            {caption}
          </Text>
        ) : null}

        {editing ? (
          <>
            <Form className="_llm-provider-form">
              <Form.Item label={t('llmProvider.field.url')}>
                <Input
                  size="full"
                  value={url}
                  onChange={setUrl}
                  placeholder={t('llmProvider.placeholder.url')}
                  disabled={saving}
                />
              </Form.Item>
              <Form.Item label={t('llmProvider.field.apiKey')}>
                <Input.Password
                  size="full"
                  value={apiKey}
                  onChange={setApiKey}
                  placeholder={t('llmProvider.placeholder.apiKey')}
                  autoComplete="new-password"
                  rules={false}
                  disabled={saving}
                />
              </Form.Item>
              <Form.Item label={t('llmProvider.field.model')}>
                <Input
                  size="full"
                  value={model}
                  onChange={setModel}
                  placeholder={t('llmProvider.placeholder.model')}
                  disabled={saving}
                />
              </Form.Item>
            </Form>
            <div className="_llm-provider-actions">
              <Button type="primary" onClick={() => void handleSave()} loading={saving} disabled={saving}>
                {t('llmProvider.save')}
              </Button>
              <Button onClick={cancelEdit} disabled={saving}>
                {t('common.cancel')}
              </Button>
            </div>
          </>
        ) : provider ? (
          <>
            <Text theme="text" parent="div">
              <span className="_llm-provider-meta">{t('llmProvider.field.url')}: </span>
              <code>{provider.url}</code>
            </Text>
            <Text theme="text" parent="div">
              <span className="_llm-provider-meta">{t('llmProvider.field.model')}: </span>
              <code>{provider.model}</code>
            </Text>
            <Text theme="weak" parent="div" className="_llm-provider-note">
              {t('llmProvider.apiKey.set')}
            </Text>
            <div className="_llm-provider-actions">
              <Button type="primary" onClick={enterEdit}>
                {t('llmProvider.edit')}
              </Button>
              <Button onClick={() => void handleClear()}>{t('llmProvider.clear')}</Button>
            </div>
          </>
        ) : (
          <>
            <Text theme="weak" parent="div" className="_llm-provider-note">
              {notConfiguredNote}
            </Text>
            <div className="_llm-provider-actions">
              <Button type="primary" onClick={enterEdit}>
                {t('llmProvider.configure')}
              </Button>
            </div>
          </>
        )}
      </Card.Body>
    </Card>
  );
}