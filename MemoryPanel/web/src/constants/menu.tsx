/**
 * 菜单元数据 — 从 App.tsx 抽出
 *
 * 包含页面 ID 类型、页面元信息、分组排序、分组图标。
 * Sidebar / TabBar / 路由等模块共用。
 *
 * DSH 特化（Wave 2A）：workbench_board（任务工作台）与 llm_provider（多 provider 自服务）
 * 两个页面已退场，PageId 与分组同步收敛；`affix` 语义保留（当前无页面使用，TabBar 仍按它
 * 判定可否关闭）。
 */
import { useTranslation } from 'react-i18next';
import {
  UserIcon,
  UsergroupIcon,
  LockOnIcon,
  BooksIcon,
  CodeIcon,
  ToolsIcon,
  ChatIcon,
  SettingIcon,
} from 'tea-icons-react';

export type PageId =
  | 'wiki'
  | 'code'
  | 'skills'
  | 'chat_memory'
  | 'soul'
  | 'team_members'
  | 'team_agents'
  | 'api_keys'
  | 'settings';

/** 页面元数据 */
export interface PageMeta {
  id: PageId;
  label: string;
  desc?: string;
  /** 所属分组，用于侧边栏菜单分组标题 */
  group: string;
  /** 分组内排序，越小越靠前 */
  order: number;
  /** 固定标签页不可关闭（当前无页面使用，保留字段供 TabBar 判定） */
  affix?: boolean;
}

// 使用 useTranslation 的 hook 版本
export function usePageMeta(): Record<PageId, PageMeta> {
  const { t } = useTranslation();
  return {
    wiki: {
      id: 'wiki',
      label: t('menu.wiki'),
      desc: t('menu.desc.wiki'),
      group: t('menu.group.assets'),
      order: 2,
    },
    code: {
      id: 'code',
      label: t('menu.code'),
      desc: t('menu.desc.code'),
      group: t('menu.group.assets'),
      order: 3,
    },
    skills: {
      id: 'skills',
      label: t('menu.skills'),
      desc: t('menu.desc.skills'),
      group: t('menu.group.assets'),
      order: 4,
    },
    chat_memory: {
      id: 'chat_memory',
      label: t('menu.chat_memory'),
      desc: t('menu.desc.chat_memory'),
      group: t('menu.group.assets'),
      order: 5,
    },
    soul: {
      id: 'soul',
      label: t('menu.soul'),
      desc: t('menu.desc.soul'),
      group: t('menu.group.assets'),
      order: 6,
    },
    team_members: {
      id: 'team_members',
      label: t('menu.team_members'),
      desc: t('menu.desc.team_members'),
      group: t('menu.group.organization'),
      order: 0,
    },
    team_agents: {
      id: 'team_agents',
      label: t('menu.team_agents'),
      desc: t('menu.desc.team_agents'),
      group: t('menu.group.organization'),
      order: 1,
    },
    api_keys: {
      id: 'api_keys',
      label: t('menu.api_keys'),
      desc: t('menu.desc.api_keys'),
      group: t('menu.group.organization'),
      order: 2,
    },
    settings: {
      id: 'settings',
      label: t('menu.settings'),
      desc: t('menu.desc.settings'),
      group: t('menu.group.organization'),
      order: 4,
    },
  };
}

/** 分组排序顺序 */
export const GROUP_ORDER_KEYS = ['organization', 'assets'] as const;

/** 每个页面在侧边栏菜单中的图标（Tea 官方图标，size 16） */
export const ITEM_ICON: Record<PageId, JSX.Element> = {
  team_members: <UserIcon size={16} />,
  team_agents: <UsergroupIcon size={16} />,
  api_keys: <LockOnIcon size={16} />,
  settings: <SettingIcon size={16} />,
  wiki: <BooksIcon size={16} />,
  code: <CodeIcon size={16} />,
  skills: <ToolsIcon size={16} />,
  chat_memory: <ChatIcon size={16} />,
  soul: <UserIcon size={16} />,
};

/** 分组图标（组织与权限 / 资产管理） */
export const GROUP_ICON: Record<string, JSX.Element> = {
  organization: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  assets: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 2l9 5-9 5-9-5 9-5z" />
      <path d="M3 12l9 5 9-5" />
      <path d="M3 17l9 5 9-5" />
    </svg>
  ),
};