/**
 * 路由表定义
 *
 * 使用 react-router 的 createHashRouter / RouterProvider。
 * ConsoleLayout 作为父路由，各页面作为子路由。
 *
 * DSH 特化（Wave 2A）：任务工作台 / LLM Provider 自服务 / 多 agent 接入指引三页已退场，
 * 首页重定向到资产管理（wiki）——不再有"工作台看板"概念。
 */
import { createHashRouter, Navigate, type RouteObject } from 'react-router-dom';
import { ConsoleLayout } from '@/layouts/ConsoleLayout';
import { WikiPage } from '@/pages/WikiPage';
import { CodePage } from '@/pages/CodePage';
import { SkillsPage } from '@/pages/SkillsPage';
import { ChatMemoryPage } from '@/pages/ChatMemoryPage';
import { SoulPage } from '@/pages/SoulPage';
import { MembersPage } from '@/pages/MembersPage';
import { AgentsPage } from '@/pages/AgentsPage';
import { ApiKeysPage } from '@/pages/ApiKeysPage';
import { SettingsPage } from '@/pages/SettingsPage';

export const routes: RouteObject[] = [
  {
    path: '/',
    element: <ConsoleLayout />,
    children: [
      { index: true, element: <Navigate to="/wiki" replace /> },
      { path: 'wiki', element: <WikiPage /> },
      { path: 'code', element: <CodePage /> },
      { path: 'skills', element: <SkillsPage /> },
      { path: 'memory', element: <ChatMemoryPage /> },
      { path: 'soul', element: <SoulPage /> },
      { path: 'team/members', element: <MembersPage /> },
      { path: 'team/agents', element: <AgentsPage /> },
      { path: 'team/api-keys', element: <ApiKeysPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
];

/**
 * 使用 HashRouter — 保持与旧版 hash 路由兼容，
 * 避免刷新 404（静态部署不需要服务端 fallback 配置）。
 */
export const router = createHashRouter(routes);
