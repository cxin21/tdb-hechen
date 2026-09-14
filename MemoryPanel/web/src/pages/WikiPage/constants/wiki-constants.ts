/**
 * wiki-constants —— Wiki 资产页的常量、类型与纯工具函数。
 * 从 WikiSourcesPanel.tsx 拆出，供主面板 / 详情视图 / hooks 复用。
 *
 * 通用资产类型与 formatShortTime 已收敛到 @/lib/asset-common，此处 re-export
 * 保持原有 import 路径不变。
 */
import type { WikiDetail } from '@/lib/api/knowledge-api';
export type { SubView, ViewMode, StatusFilter } from '@/lib/asset-common';
export { formatShortTime } from '@/lib/asset-common';

/** Wiki 仅允许上传 Markdown 类文件（.md / .markdown / .txt）。 */
export const WIKI_ALLOWED_FILE_RE = /\.(md|txt|markdown)$/i;

// ===== 来源类型（手动上传 / Git 仓库） =====

/** Wiki 来源类型：upload = 手动上传；git = 从 Git 仓库拉取文档。 */
export type WikiSourceType = 'upload' | 'git';
/** 来源类型 → i18n 文案 key（用 Tea Tag soft 变体展示）。 */
export const WIKI_SOURCE_KEYS: Record<WikiSourceType, string> = {
  upload: 'wiki.source.upload',
  git: 'wiki.source.git',
};

/** 从 WikiDetail 推导来源类型：source_type === 'git' 记作 git，其余默认手动上传。 */
export function wikiSourceTypeOf(detail: { source_type?: string | null }): WikiSourceType {
  return detail.source_type === 'git' ? 'git' : 'upload';
}

/**
 * 校验是否为合法的 HTTP(S) Git 仓库地址（与 CodeGraph 注册页一致）：
 * http/https 协议、host 含点、路径不含空格、以 .git 结尾。SSH（git@…）不算合法。
 */
const WIKI_GIT_HTTP_URL_RE = /^https?:\/\/[^\s/]+\.[^\s/]+\/[^\s]+\.git$/i;
export function isValidWikiGitUrl(raw: string): boolean {
  return WIKI_GIT_HTTP_URL_RE.test(raw.trim());
}

// Wiki 状态徽章：draft=建壳未加工（待用户点 ingest）；pending=排队；processing=加工中；ready=就绪；failed=失败；missing=KS 数据丢失。
// 走 Tea Tag 的语义 theme（soft 变体），随主题响应，不用硬编码调色板色。
export const WIKI_STATUS_THEME: Record<WikiDetail['status'], 'warning' | 'success' | 'error' | 'default'> = {
  draft: 'warning',
  pending: 'warning',
  processing: 'warning',
  ready: 'success',
  failed: 'error',
  missing: 'error',
};
export const WIKI_STATUS_KEY: Record<WikiDetail['status'], string> = {
  draft: 'wiki.status.draft',
  pending: 'wiki.status.pending',
  processing: 'wiki.status.processing',
  ready: 'wiki.status.ready',
  failed: 'wiki.status.failed',
  missing: 'wiki.status.missing',
};

export type WikiScopeTab = 'all' | 'team' | 'fixed' | 'scope';
export const SCOPE_LABEL_KEYS: Record<WikiScopeTab, string> = {
  all: 'wiki.scope.all',
  team: 'wiki.scope.team',
  fixed: 'wiki.scope.fixed',
  scope: 'wiki.scope.scope',
};

export type DetailTab = 'overview' | 'graph' | 'pages' | 'search';

export interface SearchResult {
  path: string;
  title: string;
  snippet: string;
  score: number;
  type: string;
}

export const TYPE_COLORS: Record<string, string> = {
  entity: 'var(--tea-color-bg-brand-default)',
  concept: 'var(--tea-color-bg-warning-default)',
  source: 'var(--tea-color-bg-amber-default)',
  query: 'var(--tea-color-bg-success-default)',
  synthesis: 'var(--tea-color-bg-error-default)',
  overview: 'var(--tea-color-bg-yellow-default)',
  comparison: 'var(--tea-color-bg-secondary-active)',
  finding: 'var(--tea-color-bg-warning-default)',
  thesis: 'var(--tea-color-bg-error-default)',
  methodology: 'var(--tea-color-bg-success-default)',
  other: 'var(--tea-color-bg-tertiary-default)',
  raw: 'var(--tea-color-bg-secondary-default)',
};
export const TYPE_COLOR_FALLBACK = 'var(--tea-color-text-tertiary)';
