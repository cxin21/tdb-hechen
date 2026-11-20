/**
 * starmap/stations/SettingsStation.tsx — 设置站（新壳）。
 *
 * 这一站是只读概览，不是表单：把两个服务当前「生效值」摊开给人看，谁都能确认现在到底
 * 跑在什么模型 / 什么阈值上；任何修改仍走旧控制台的配置表单。
 *
 * 为什么先不做表单：旧设置页是三页签 + configCatalog.ts 近 3000 行的配置目录
 * （wiki / memory / rerank 共 60 余项校准常量，每项还带校验与「重启后生效」语义）。
 * 在没有逐项对齐前照抄一遍，等于把一套已验证的写入路径换成没验过的路径。
 */
import { useNavigate } from 'react-router-dom';
import { Empty, KvList, Note, Surface, Tag } from '../kit';
import { useResource, cacheKey } from '../cache';
import { useCurrentRole } from '@/services/useCurrentRole';
import { useAuthStore } from '@/stores/auth';
import {
  settingsApi,
  rerankModelApi,
  type SettingsView,
  type SettingsTarget,
  type RerankModelStatus,
} from '@/lib/api/settings';
import { getErrorMessage } from '@/lib/error-message';

const TARGET_LABEL: Record<SettingsTarget, string> = {
  knowledge: '知识服务（MemoryKnowledge）',
  memory: '记忆服务（MemoryCore）',
};

const SOURCE_HINT: Record<string, string> = {
  env: '环境变量',
  yaml: '配置文件',
  override: '面板覆盖',
};

function errText(e: unknown): string {
  return getErrorMessage(e);
}

/** 只统计「有值」的整组，空组不画成 0。 */
function groupCount(view: SettingsView): string {
  const groups: Array<[string, unknown]> = [
    ['抽取', view.extraction],
    ['分层尺', view.layerRuler],
    ['注入', view.injection],
    ['核心记忆', view.coreMemory],
    ['生命周期', view.lifecycle],
  ];
  const present = groups.filter(([, v]) => v && Object.keys(v as object).length > 0);
  if (!present.length) return '—';
  return present.map(([name, v]) => name + ' ' + String(Object.keys(v as object).length) + ' 项').join(' · ');
}

function ViewPanel({ target }: { target: SettingsTarget }) {
  const res = useResource<SettingsView>({
    key: cacheKey('settings.view', target),
    fetcher: () => settingsApi.get(target),
    ttl: 60_000,
    tags: ['settings:' + target],
  });
  const v = res.data;

  return (
    <Surface dense title={TARGET_LABEL[target]} aside={<span className="stk-meta">只读 · 生效值</span>}>
      {res.loading && !v ? <Note>正在读取生效配置…</Note> : null}
      {res.error ? <Note tone="bad">未读取成功：{errText(res.error)}</Note> : null}
      {res.stale && !res.error ? <Note tone="warn">显示的是上次同步的数据，本次刷新未成功。</Note> : null}
      {v ? (
        <KvList
          items={[
            { k: '模型', v: v.llm.model, mono: true },
            { k: '地址', v: v.llm.baseUrl, mono: true },
            {
              k: '密钥',
              v: v.llm.hasApiKey ? '已配置 ' + v.llm.apiKeyMasked : '未配置',
              mono: v.llm.hasApiKey,
            },
            { k: '来源', v: SOURCE_HINT[v.llm.source] ?? v.llm.source },
            { k: '超时', v: v.llm.timeoutMs ? v.llm.timeoutMs + ' ms' : '—' },
            {
              k: '向量模型',
              v: v.embedding.model + (v.embedding.dimensions ? ' · ' + String(v.embedding.dimensions) + ' 维' : ''),
              mono: true,
            },
            {
              k: '重排',
              v: v.rerank
                ? (v.rerank.enabled === false ? '关闭' : '开启') +
                  ' · ' +
                  (v.rerank.provider ?? '—') +
                  ' / ' +
                  (v.rerank.model ?? '—')
                : '—',
            },
            {
              k: '重要度降权',
              v: v.importancePenalty?.enabled
                ? '开启 · 系数 ' + String(v.importancePenalty.penalty ?? '—')
                : '关闭',
            },
            { k: '抽取标注', v: v.worthiness?.extractionEnabled ? '开启' : '关闭' },
            { k: '整组阈值', v: groupCount(v) },
          ]}
        />
      ) : null}
      {res.updatedAt ? (
        <p className="stk-hint-inline">上次同步 {new Date(res.updatedAt).toLocaleTimeString('zh-CN')}</p>
      ) : null}
    </Surface>
  );
}

function RerankPanel() {
  const res = useResource<RerankModelStatus>({
    key: cacheKey('settings.rerankModel', 'local'),
    fetcher: () => rerankModelApi.status(),
    ttl: 30_000,
    tags: ['settings:rerank'],
  });
  const s = res.data;
  const stateText: Record<string, string> = {
    idle: '未下载',
    downloading: '下载中',
    ready: '就绪',
    failed: '失败',
  };
  const done = s ? s.files.filter((f) => f.state === 'done').length : 0;

  return (
    <Surface dense title="本地重排模型" aside={<span className="stk-meta">只读</span>}>
      {res.loading && !s ? <Note>正在读取模型状态…</Note> : null}
      {res.error ? <Note tone="bad">未读取成功：{errText(res.error)}</Note> : null}
      {s ? (
        <>
          <KvList
            items={[
              { k: '状态', v: (stateText[s.state] ?? s.state) + (s.state === 'downloading' ? ' · ' + String(s.percent) + '%' : '') },
              { k: '仓库', v: s.repo, mono: true },
              { k: '目录', v: s.modelDir, mono: true },
              { k: '文件', v: String(done) + ' / ' + String(s.files.length) + ' 已就绪' },
              { k: '错误', v: s.error ?? '—' },
            ]}
          />
          {s.files.length ? (
            <div className="stk-list" style={{ marginTop: 8 }}>
              {s.files.map((f) => (
                <div className="stk-row" key={f.rel}>
                  <span className="stk-row-main">
                    <span className="stk-row-label stk-mono">{f.rel}</span>
                  </span>
                  <span className="stk-row-tail">
                    <Tag tone={f.state === 'done' ? 'ink' : f.state === 'failed' ? 'bad' : 'warn'}>
                      {f.state === 'done' ? '就绪' : f.state === 'failed' ? '失败' : f.state === 'downloading' ? '下载中' : '待下载'}
                    </Tag>
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </Surface>
  );
}

export default function SettingsStation() {
  const nav = useNavigate();
  const auth = useAuthStore((s) => s.auth);
  const role = useCurrentRole();

  if (!auth) {
    return (
      <div className="starmap-root">
        <div className="st-body st-body-single">
          <div className="st-main">
            <Empty title="未登录" hint="配置读的是服务端当前生效值，需要登录并具备管理员角色。" />
          </div>
        </div>
      </div>
    );
  }

  const isAdmin = role === 'admin';

  return (
    <div className="starmap-root">
      <div className="st-body st-body-single">
        <div className="st-main">
          <div className="st-toolbar">
            <div className="st-toolbar-left sm-dim2">设置 · 生效值概览</div>
          </div>
          <div className="sm-scroll">
            {isAdmin ? (
              <>
                <Note>
                  这里只读：显示两个服务当前实际生效的模型、向量、重排与整组阈值。修改配置仍走旧控制台的表单——
                  那套表单带逐项校验和「重启后生效 / 重建向量」的提示，逐项对齐前不照抄第二遍。
                </Note>
                <div className="stk-row-actions" style={{ margin: '8px 0' }}>
                  <button type="button" className="stk-btn is-ghost is-sm" onClick={() => nav('/legacy/settings')}>
                    去旧控制台编辑配置
                  </button>
                </div>
                <ViewPanel target="knowledge" />
                <ViewPanel target="memory" />
                <RerankPanel />
              </>
            ) : (
              <Note tone="warn">
                设置页需要全局管理员。当前角色：{role ?? '未知'}——你可以查看星图与团队，但服务端配置不在这里展示，
                如需调整请联系管理员。
              </Note>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
