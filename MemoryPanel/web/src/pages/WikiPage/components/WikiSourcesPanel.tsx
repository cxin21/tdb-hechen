/**
 * WikiSourcesPanel —— Wiki 资产页主面板（列表视图 + 详情/创建/分配组装）。
 * 列表视图渲染与组件组装；状态/数据逻辑在 useWikiSources，详情在 WikiDetailView，
 * 展示小组件 / 常量工具 / 共享 Markdown 分别独立收口。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Card, Form, Input, Justify, MetricsBoard, Modal, SearchBox, Segment, Select, StatusTip, Table, Tag, Text } from 'tea-component';
import { BooksIcon, ChevronRightIcon, UsergroupIcon, ViewListIcon, ViewModuleIcon } from 'tea-icons-react';
import { knowledgeApi } from '@/lib/api/knowledge-api';
import type { WikiDetail, WikiSourceProbeResult } from '@/lib/api/knowledge-api';
import { tea } from '@/lib/tea-bridge';
import AllocateAssetDialog from '@/components/asset/AllocateAssetDialog';
import { AssetPageHeader } from '@/components/asset/AssetPageHeader';
import { formatShortTime, SCOPE_LABEL_KEYS, WIKI_SOURCE_KEYS, isValidWikiGitUrl, wikiSourceTypeOf, type StatusFilter, type ViewMode, type WikiScopeTab, type WikiSourceType } from '../constants/wiki-constants';
import { WikiOwnerLabel, WikiStatusBadge } from './wiki-ui';
import { WikiActions } from './wiki-detail-components';
import { useWikiSources } from '../hooks/useWikiSources';
import { WikiDetailView } from './wiki-detail-view';
import '@/components/asset/asset-card.css';
import '../styles/wiki-sources-panel.css';

const { scrollable } = Table.addons;

/** 列表/卡片来源角标：Git 源用 primary soft Tag，手动上传用 default soft Tag。 */
function WikiSourceTag({ sourceType }: { sourceType?: string | null }) {
  const { t } = useTranslation();
  const kind: WikiSourceType = wikiSourceTypeOf({ source_type: sourceType });
  return (
    <Tag theme={kind === 'git' ? 'primary' : 'default'} variant="soft" size="sm">
      {t(WIKI_SOURCE_KEYS[kind])}
    </Tag>
  );
}

/**
 * 源管理徽标（DS-PANEL-UI-WIKI-SOURCE-001 §1.2/§1.4，仅 git 源；
 * U-C2：stale 徽标对齐 ChatMemoryPanel `_memory-badge` 徽标体系，跨页一致）：
 * - stale=true → "待重新拉取" warning 文本徽标；sync_error 一并放进 title 可见；
 *   徽标保持到重建成功（后端清 stale），refetch 返回 202 时也不消失。
 * - enabled=false → "已暂停"提示（自动同步跳过，不影响已摄入页面）。
 */
function WikiSourceBadges({ source }: { source: WikiDetail }) {
  const { t } = useTranslation();
  if (source.source_type !== 'git') return null;
  return (
    <>
      {source.stale && (
        <span
          className="_wiki-source-badge _wiki-source-badge--warning"
          title={source.sync_error ? `${t('wiki.badge.stale')}：${source.sync_error}` : t('wiki.badge.stale')}
        >
          {t('wiki.badge.stale')}
        </span>
      )}
      {source.enabled === false && (
        <span title={t('wiki.badge.pausedTip')}>
          <Tag theme="default" variant="soft" size="sm">
            {t('wiki.badge.paused')}
          </Tag>
        </span>
      )}
    </>
  );
}

export default function WikiSourcesPanel() {
  const { t } = useTranslation();
  const wiki = useWikiSources();

  const {
    // context
    activeTeam,
    activeTeamId,
    currentUser,
    teamAgents,
    // list view
    sources,
    loading,
    scopeTab,
    setScopeTab,
    keyword,
    setKeyword,
    statusFilter,
    setStatusFilter,
    viewMode,
    setViewMode,
    subView,
    // create
    showCreate,
    setShowCreate,
    newName,
    setNewName,
    submitting,
    setSubmitting,
    // allocate
    allocateTarget,
    setAllocateTarget,
    agentFilter,
    setAgentFilter,
    // fetch & handlers
    fetchSources,
    fetchFixedBindings,
    handleIngest,
    handleDelete,
    handleUpdateSource,
    handleTestSource,
    handleToggleEnabled,
    handleRefetch,
    sourceBusyId,
    openDetail,
    handleUnbindWiki,
    // computed
    stats,
    filteredSources,
    runningWikiIds,
    ingestBusy,
  } = wiki;

  // ---- 新建 Wiki：来源类型 + Git 仓库字段（本组件局部状态，不进共享 store） ----
  const [createSourceType, setCreateSourceType] = useState<WikiSourceType>('upload');
  const [gitUrl, setGitUrl] = useState('');
  const [gitBranch, setGitBranch] = useState('main');
  const [gitPathInclude, setGitPathInclude] = useState('');
  const [gitPathExclude, setGitPathExclude] = useState('');

  const resetCreateForm = () => {
    setCreateSourceType('upload');
    setGitUrl('');
    setGitBranch('main');
    setGitPathInclude('');
    setGitPathExclude('');
  };
  const openCreate = () => {
    resetCreateForm();
    setShowCreate(true);
  };

  const isGitCreate = createSourceType === 'git';
  const gitUrlInvalid = !!gitUrl.trim() && !isValidWikiGitUrl(gitUrl);
  const gitCreateReady = !isGitCreate || (!!gitUrl.trim() && !gitUrlInvalid);
  const canCreate = !!newName.trim() && gitCreateReady;

  // ---- 编辑源（git 源卡片"编辑"→ 行内弹窗 url/branch + 测试连接/分支下拉）----
  const [editTarget, setEditTarget] = useState<WikiDetail | null>(null);
  const [editUrl, setEditUrl] = useState('');
  const [editBranch, setEditBranch] = useState('');
  const [probe, setProbe] = useState<WikiSourceProbeResult | null>(null);

  const openEdit = (source: WikiDetail) => {
    setEditTarget(source);
    setEditUrl(source.source_url ?? '');
    setEditBranch(source.branch ?? '');
    setProbe(null);
  };
  const closeEdit = () => setEditTarget(null);

  const editUrlInvalid = !!editUrl.trim() && !isValidWikiGitUrl(editUrl);
  // 只把"实际变更"的字段发给后端：KS 仅在 url/branch 实际变化时置 stale（同值提交不误标）。
  const urlChanged = editTarget !== null && editUrl.trim() !== (editTarget.source_url ?? '');
  const branchChanged = editTarget !== null && editBranch.trim() !== (editTarget.branch ?? '');
  const editSaving = editTarget !== null && sourceBusyId === editTarget.wiki_id;
  const canSaveEdit =
    editTarget !== null &&
    !!editUrl.trim() &&
    !editUrlInvalid &&
    (urlChanged || branchChanged) &&
    !editSaving;

  const handleEditTest = async () => {
    if (!editTarget || editSaving) return;
    setProbe(null);
    // 传候选 URL 覆盖（后端走完整校验）；为空则探测已存源
    const result = await handleTestSource(editTarget.wiki_id, editUrl.trim() || undefined);
    if (result) setProbe(result);
  };

  const handleEditSave = async () => {
    if (!editTarget || !canSaveEdit) return;
    const ok = await handleUpdateSource(editTarget.wiki_id, {
      ...(urlChanged ? { source_url: editUrl.trim() } : {}),
      ...(branchChanged ? { branch: editBranch.trim() } : {}),
    });
    if (ok) closeEdit();
  };

  const handleCreateWiki = async () => {
    const name = newName.trim();
    if (!canCreate || !activeTeamId) return;
    setSubmitting(true);
    try {
      const gitOpts = isGitCreate
        ? {
            source_type: 'git',
            source_url: gitUrl.trim(),
            ...(gitBranch.trim() ? { branch: gitBranch.trim() } : {}),
            ...(gitPathInclude.trim() ? { path_include: gitPathInclude.trim() } : {}),
            ...(gitPathExclude.trim() ? { path_exclude: gitPathExclude.trim() } : {}),
          }
        : undefined;
      await knowledgeApi.wiki.create(activeTeamId, name, gitOpts);
      tea.notify.success(t('wiki.notify.created', { name }));
      setShowCreate(false);
      setNewName('');
      resetCreateForm();
      fetchSources();
    } catch (e: unknown) {
      tea.notify.error(e);
    } finally {
      setSubmitting(false);
    }
  };

  if (subView === 'detail') {
    return <WikiDetailView store={wiki} />;
  }

  return (
    <div className="_asset-wiki-page">
      <AssetPageHeader
        title={t('wiki.title')}
        subtitle={
          <Text theme="label">
            {activeTeam
              ? t('wiki.subtitle.team', { name: activeTeam.name, count: stats.total })
              : t('wiki.subtitle.global', { count: stats.total })}
          </Text>
        }
        scope={
          <Segment
            value={scopeTab}
            onChange={(value) => setScopeTab(value as WikiScopeTab)}
            options={(['team', 'fixed'] as WikiScopeTab[]).map((tab) => ({
              value: tab,
              text: t(SCOPE_LABEL_KEYS[tab]),
            }))}
          />
        }
        agent={
          scopeTab === 'fixed' ? (
            <Select
              appearance="button"
              matchButtonWidth
              value={agentFilter}
              onChange={setAgentFilter}
              disabled={teamAgents.length === 0}
              placeholder={t('wiki.noAgentPlaceholder')}
              options={teamAgents.map((agent) => ({
                value: agent.id,
                text: `${agent.name}（${agent.id}）`,
              }))}
            />
          ) : undefined
        }
        actions={
          // 创建（新增团队池资产）与 memory/skill 对齐，放右上角 header；
          // 仅「团队资产」tab 开放，固定资产 tab 只做绑定/查看。
          scopeTab !== 'fixed' ? (
            <Button type="primary" onClick={openCreate} data-guide="create-wiki">
              {t('wiki.create')}
            </Button>
          ) : undefined
        }
      />

      <Card className="_asset-wiki-content-card">
        <Card.Body>
          <div className="_asset-wiki-stats">
            <MetricsBoard title={t('wiki.metrics.total')} value={stats.total} />
            <MetricsBoard title={t('wiki.metrics.ready')} value={stats.ready} />
            <MetricsBoard title={t('wiki.metrics.processing')} value={stats.processing} />
            <MetricsBoard title={t('wiki.metrics.totalPages')} value={stats.totalPages} />
          </div>
          <Table.ActionPanel>
            <Justify
              right={
                <div className="_asset-wiki-toolbar">
                  <SearchBox
                    value={keyword}
                    onChange={setKeyword}
                    placeholder={t('wiki.searchPlaceholder')}
                  />
                  <Segment
                    value={statusFilter}
                    onChange={(value) => setStatusFilter(value as StatusFilter)}
                    options={[
                      { value: 'all', text: t('wiki.filter.allStatus') },
                      { value: 'ready', text: t('wiki.filter.ready') },
                      { value: 'processing', text: t('wiki.filter.processing') },
                    ]}
                  />
                  <Segment
                    value={viewMode}
                    onChange={(value) => setViewMode(value as ViewMode)}
                    options={[
                      { value: 'card', text: <ViewModuleIcon /> },
                      { value: 'list', text: <ViewListIcon /> },
                    ]}
                  />
                </div>
              }
            />
          </Table.ActionPanel>

          {loading ? (
            <div className="_asset-wiki-skeleton-grid">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="_asset-wiki-skeleton-card">
                  <div className="_asset-wiki-skeleton-line _asset-wiki-skeleton-line--title" />
                  <div className="_asset-wiki-skeleton-line _asset-wiki-skeleton-line--desc" />
                  <div className="_asset-wiki-skeleton-line _asset-wiki-skeleton-line--meta" />
                </div>
              ))}
            </div>
          ) : sources.length === 0 ? (
            <StatusTip
              status="empty"
              emptyText={
                <div className="_asset-wiki-empty">
                  <BooksIcon size="large" />
                  <Text>{t('wiki.empty.title')}</Text>
                  <Text theme="label">{t('wiki.empty.desc')}</Text>
                </div>
              }
            />
          ) : filteredSources.length === 0 ? (
            <StatusTip status="empty" emptyText={t('wiki.empty.filtered')} />
          ) : viewMode === 'card' ? (
            <div className="_asset-wiki-grid _view-swap">
              {filteredSources.map((source) => (
                <div
                  key={source.wiki_id}
                  className="_asset-wiki-card"
                  onClick={() => openDetail(source.wiki_id)}
                >
                  <div className="_asset-wiki-card-head">
                    <BooksIcon size={16} />
                    <span className="_asset-wiki-card-name" title={source.name}>
                      {source.name}
                    </span>
                    <ChevronRightIcon size={14} className="_asset-wiki-card-chevron" />
                  </div>
                  <div className="_asset-wiki-card-meta">
                    <WikiStatusBadge status={source.status} />
                    <WikiSourceTag sourceType={source.source_type} />
                    <WikiSourceBadges source={source} />
                    <span>
                      {t('wiki.card.pagesAndTime', { pages: source.page_count ?? 0, time: formatShortTime(source.last_sync_at) })}
                    </span>
                  </div>
                  <div className="_asset-wiki-card-owner">
                    <UsergroupIcon size={12} />
                    {scopeTab === 'fixed' ? (
                      t('wiki.fixedAsset', { agent: agentFilter || t('wiki.noAgent') })
                    ) : source.owner_user_id ? (
                      <WikiOwnerLabel userId={source.owner_user_id} currentUserId={currentUser} />
                    ) : (
                      t('wiki.teamPool')
                    )}
                  </div>
                  <div className="_asset-wiki-card-id">{t('wiki.card.id', { id: source.wiki_id })}</div>
                  <WikiActions
                    source={source}
                    scopeTab={scopeTab}
                    ingestBusy={ingestBusy}
                    isCurrentIngesting={runningWikiIds.has(source.wiki_id)}
                    sourceBusy={sourceBusyId === source.wiki_id}
                    onIngest={handleIngest}
                    onAllocate={setAllocateTarget}
                    onUnbind={handleUnbindWiki}
                    onDelete={handleDelete}
                    onEdit={openEdit}
                    onToggleEnabled={handleToggleEnabled}
                    onRefetch={handleRefetch}
                  />
                </div>
              ))}
            </div>
          ) : (
            <div className="_view-swap">
            <Table
              records={filteredSources}
              recordKey="wiki_id"
              addons={[scrollable({ minWidth: 1040 })]}
              columns={[
                {
                  key: 'name',
                  header: t('wiki.table.name'),
                  width: 240,
                  render: (source) => (
                    <button
                      type="button"
                      className="_asset-wiki-row-name"
                      onClick={() => openDetail(source.wiki_id)}
                    >
                      <BooksIcon size={14} />
                      <span>{source.name}</span>
                      <WikiSourceTag sourceType={source.source_type} />
                      <ChevronRightIcon size={12} />
                    </button>
                  ),
                },
                {
                  key: 'status',
                  header: t('wiki.table.status'),
                  width: 140,
                  render: (source) => (
                    <>
                      <WikiStatusBadge status={source.status} /> <WikiSourceBadges source={source} />
                    </>
                  ),
                },
                {
                  key: 'page_count',
                  header: t('wiki.table.pageCount'),
                  width: 80,
                  render: (source) => source.page_count ?? 0,
                },
                {
                  key: 'owner',
                  header: t('wiki.table.owner'),
                  width: 180,
                  render: (source) =>
                    scopeTab === 'fixed' ? (
                      <span className="_asset-wiki-inline-icon">
                        <UsergroupIcon size={12} />
                        {agentFilter || t('wiki.noAgent')}
                      </span>
                    ) : source.owner_user_id ? (
                      <WikiOwnerLabel userId={source.owner_user_id} currentUserId={currentUser} />
                    ) : (
                      <Text theme="label">{t('wiki.teamPool.short')}</Text>
                    ),
                },
                {
                  key: 'last_sync_at',
                  header: t('wiki.table.lastSync'),
                  width: 140,
                  render: (source) => (
                    <Text theme="label">{formatShortTime(source.last_sync_at)}</Text>
                  ),
                },
                {
                  key: 'wiki_id',
                  header: t('wiki.table.wikiId'),
                  width: 220,
                  render: (source) => <span className="_asset-wiki-id">{source.wiki_id}</span>,
                },
                {
                  key: 'actions',
                  header: t('wiki.table.actions'),
                  width: 240,
                  fixed: 'right',
                  render: (source) => (
                    <WikiActions
                      source={source}
                      scopeTab={scopeTab}
                      ingestBusy={ingestBusy}
                      isCurrentIngesting={runningWikiIds.has(source.wiki_id)}
                      sourceBusy={sourceBusyId === source.wiki_id}
                      onIngest={handleIngest}
                      onAllocate={setAllocateTarget}
                      onUnbind={handleUnbindWiki}
                      onDelete={handleDelete}
                      onEdit={openEdit}
                      onToggleEnabled={handleToggleEnabled}
                      onRefetch={handleRefetch}
                    />
                  ),
                },
              ]}
            />
            </div>
          )}
        </Card.Body>
      </Card>

      {/* Edit Source Modal（git 源：url/branch 可改；测试连接预览候选 URL + 分支下拉） */}
      {editTarget && (
        <Modal
          visible
          caption={t('wiki.edit.caption', { name: editTarget.name })}
          size="m"
          onClose={closeEdit}
          disableEscape={editSaving}
        >
          <Modal.Body>
            {/* U-C2：Form 纵向布局 + 全宽，对齐 ChatMemoryPage ImportBlockDialog 的 Form/Input 风格 */}
            <Form layout="vertical" style={{ width: '100%' }}>
              <Form.Item label={t('wiki.edit.url')} required extra={t('wiki.create.gitUrlExtra')}>
                <Input
                  size="full"
                  value={editUrl}
                  onChange={setEditUrl}
                  placeholder="https://git.example.com/org/repo.git"
                />
              </Form.Item>
              {editUrlInvalid && (
                <Form.Item>
                  <Alert type="error">{t('wiki.create.invalidUrl')}</Alert>
                </Form.Item>
              )}
              <Form.Item label={t('wiki.edit.branch')}>
                <Input
                  size="full"
                  value={editBranch}
                  onChange={setEditBranch}
                  placeholder={t('wiki.create.gitBranchPlaceholder')}
                />
              </Form.Item>
              {/* 测试连接：编辑时预览候选 URL（body.source_url 覆盖），可达时下拉选分支 */}
              <Form.Item>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Button type="weak" loading={editSaving} onClick={handleEditTest}>
                    {t('wiki.edit.test')}
                  </Button>
                  {probe && probe.reachable && probe.branches.length > 0 && (
                    <Select
                      size="m"
                      value={editBranch}
                      onChange={setEditBranch}
                      placeholder={t('wiki.edit.pickBranch')}
                      options={probe.branches.map((b) => ({ value: b, text: b }))}
                    />
                  )}
                </div>
              </Form.Item>
              {probe && (
                <Form.Item>
                  {probe.reachable ? (
                    <Alert type="success">{t('wiki.edit.reachable', { count: probe.branches.length })}</Alert>
                  ) : (
                    <Alert type="error">{t('wiki.edit.unreachable', { error: probe.error || '-' })}</Alert>
                  )}
                </Form.Item>
              )}
              <Form.Item>
                <Alert type="info">{t('wiki.edit.staleHint')}</Alert>
              </Form.Item>
            </Form>
          </Modal.Body>
          <Modal.Footer>
            <Button type="primary" onClick={handleEditSave} disabled={!canSaveEdit} loading={editSaving}>
              {editSaving ? t('wiki.edit.saving') : t('wiki.edit.save')}
            </Button>
            <Button onClick={closeEdit} disabled={editSaving}>
              {t('common.cancel')}
            </Button>
          </Modal.Footer>
        </Modal>
      )}

      {/* Create Modal */}
      {showCreate && (
        <Modal
          visible
          caption={t('wiki.create.caption')}
          size={isGitCreate ? 'm' : 's'}
          onClose={() => setShowCreate(false)}
          disableEscape={submitting}
        >
          <Modal.Body>
            <Form>
              <Form.Item label={t('wiki.create.name')} required extra={t('wiki.create.extra')}>
                <Input
                  size="full"
                  value={newName}
                  onChange={setNewName}
                  placeholder={t('wiki.create.placeholder')}
                />
              </Form.Item>
              <Form.Item label={t('wiki.create.sourceType')}>
                <Segment
                  value={createSourceType}
                  onChange={(value) => setCreateSourceType(value as WikiSourceType)}
                  options={[
                    { value: 'upload', text: t('wiki.source.upload') },
                    { value: 'git', text: t('wiki.source.git') },
                  ]}
                />
              </Form.Item>
              {isGitCreate && (
                <>
                  <Form.Item label={t('wiki.create.gitUrl')} required extra={t('wiki.create.gitUrlExtra')}>
                    <Input
                      size="full"
                      value={gitUrl}
                      onChange={setGitUrl}
                      placeholder="https://git.example.com/org/repo.git"
                    />
                  </Form.Item>
                  {gitUrlInvalid && (
                    <Form.Item>
                      <Alert type="error">{t('wiki.create.invalidUrl')}</Alert>
                    </Form.Item>
                  )}
                  <Form.Item label={t('wiki.create.gitBranch')}>
                    <Input
                      size="full"
                      value={gitBranch}
                      onChange={setGitBranch}
                      placeholder={t('wiki.create.gitBranchPlaceholder')}
                    />
                  </Form.Item>
                  <Form.Item label={t('wiki.create.pathInclude')} extra={t('wiki.create.pathIncludeExtra')}>
                    <Input
                      size="full"
                      value={gitPathInclude}
                      onChange={setGitPathInclude}
                      placeholder={t('wiki.create.pathIncludePlaceholder')}
                    />
                  </Form.Item>
                  <Form.Item label={t('wiki.create.pathExclude')}>
                    <Input
                      size="full"
                      value={gitPathExclude}
                      onChange={setGitPathExclude}
                      placeholder={t('wiki.create.pathExcludePlaceholder')}
                    />
                  </Form.Item>
                </>
              )}
            </Form>
          </Modal.Body>
          <Modal.Footer>
            <Button
              type="primary"
              onClick={handleCreateWiki}
              disabled={submitting || !canCreate}
              loading={submitting}
            >
              {submitting ? t('wiki.create.submitting') : t('wiki.create.submit')}
            </Button>
            <Button onClick={() => setShowCreate(false)} disabled={submitting}>
              {t('common.cancel')}
            </Button>
          </Modal.Footer>
        </Modal>
      )}

      {/* Allocate Wiki → Agent (固定资产) */}
      {allocateTarget && (
        <AllocateAssetDialog
          assetType="llm_wiki"
          assetLabel={allocateTarget.name}
          agents={teamAgents}
          team={activeTeam ? { team_id: activeTeam.team_id, name: activeTeam.name } : null}
          onClose={() => setAllocateTarget(null)}
          onAllocate={async (agentId) => {
            if (!activeTeamId) throw new Error(t('wiki.error.selectTeam'));
            await knowledgeApi.wiki.allocate(activeTeamId, allocateTarget.wiki_id, agentId);
            tea.notify.success(t('wiki.notify.allocated'));
            await fetchSources();
            if (scopeTab === 'fixed') await fetchFixedBindings();
          }}
        />
      )}
    </div>
  );
}
