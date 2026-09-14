/**
 * LlmProviderPanel — Memory Hub「LLM Provider」页（成员自定义 LLM Provider 自服务）。
 *
 * 顶部：当前登录用户自己的默认 Provider（url / apiKey / model）。
 * 下方：该用户「属于自己的 Agent」列表，每个可单独保存 / 清除自己的 Provider。
 * 数据来自 GET /api/v1/llm-providers?scope=me（透传到 MemoryProxy scope=me，
 * 由 proxy 按认证 user_id 归属聚合 user + 自有 agents）。写库走
 * PUT/DELETE /api/v1/llm-providers → /v3/admin/llm-providers，全链路用登录用户
 * 自己的 user_key，无共享 admin secret。
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Card, Justify, H3, Text } from 'tea-component';
import { RefreshIcon } from 'tea-icons-react';
import { llmProviderApi, type ScopeMeResult } from '@/lib/api/llm-providers';
import { useAuthStore } from '@/stores/auth';
import { tea } from '@/lib/tea-bridge';
import ProviderEditor from './ProviderEditor';
import '../styles/llm-provider-panel.css';

export default function LlmProviderPanel() {
  const { t } = useTranslation();
  const auth = useAuthStore((s) => s.auth);
  const [data, setData] = useState<ScopeMeResult | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setData(await llmProviderApi.getScopeMe());
    } catch (e) {
      tea.notify.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const userId = auth?.user_id;

  return (
    <div className="_llm-provider-body">
      <Justify
        left={
          <div>
            <H3>{t('llmProvider.title')}</H3>
            <Text theme="text" parent="div" style={{ marginTop: 4 }}>
              {t('llmProvider.desc')}
            </Text>
          </div>
        }
        right={
          <Button onClick={() => void refresh()} disabled={loading}>
            <RefreshIcon size={14} />
            <span style={{ marginLeft: 6 }}>{t('common.refresh')}</span>
          </Button>
        }
      />

      {loading && !data ? (
        <Card>
          <Text theme="weak">{t('common.loading')}</Text>
        </Card>
      ) : (
        <>
          {/* ===== 当前用户默认 Provider ===== */}
          <section className="_llm-provider-section">
            <ProviderEditor
              title={t('llmProvider.myDefault.title')}
              subjectType="user"
              subjectId={userId ?? ''}
              provider={data?.user ?? null}
              isYou
              onChanged={() => void refresh()}
            />
          </section>

          {/* ===== 属于我的 Agents ===== */}
          <section className="_llm-provider-section">
            <Card className="_llm-provider-agents-card">
              <Card.Body title={t('llmProvider.myAgents.title')}>
                {!data?.agents?.length ? (
                  <Text theme="weak">{t('llmProvider.myAgents.empty')}</Text>
                ) : (
                  <div className="_llm-provider-agents">
                    {data.agents.map((a) => (
                      <ProviderEditor
                        key={a.agent_id}
                        title={a.name}
                        caption={a.agent_id}
                        subjectType="agent"
                        subjectId={a.agent_id}
                        provider={a.provider}
                        fallbackUserDefault={data?.user != null}
                        onChanged={() => void refresh()}
                      />
                    ))}
                  </div>
                )}
              </Card.Body>
            </Card>
          </section>
        </>
      )}
    </div>
  );
}