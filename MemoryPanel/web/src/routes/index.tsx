/**
 * 路由表定义
 *
 * 使用 react-router 的 createBrowserRouter / RouterProvider。
 * ConsoleLayout 作为父路由，各页面作为子路由。
 */
import { createHashRouter, type RouteObject } from 'react-router-dom';
import { ConsoleLayout } from '@/layouts/ConsoleLayout';
import { WorkbenchPage } from '@/pages/WorkbenchPage';
import { WikiPage } from '@/pages/WikiPage';
import { CodePage } from '@/pages/CodePage';
import { SkillsPage } from '@/pages/SkillsPage';
import { ChatMemoryPage } from '@/pages/ChatMemoryPage';
import { SoulPage } from '@/pages/SoulPage';
import { MembersPage } from '@/pages/MembersPage';
import { AgentsPage } from '@/pages/AgentsPage';
import { ApiKeysPage } from '@/pages/ApiKeysPage';
import { LlmProviderPage } from '@/pages/LlmProviderPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { GuidePage } from '@/pages/GuidePage';

export const routes: RouteObject[] = [
  {
    path: '/',
    element: <ConsoleLayout />,
    children: [
      { index: true, element: <WorkbenchPage /> },
      { path: 'wiki', element: <WikiPage /> },
      { path: 'code', element: <CodePage /> },
      { path: 'skills', element: <SkillsPage /> },
      { path: 'memory', element: <ChatMemoryPage /> },
      { path: 'soul', element: <SoulPage /> },
      { path: 'team/members', element: <MembersPage /> },
      { path: 'team/agents', element: <AgentsPage /> },
      { path: 'team/api-keys', element: <ApiKeysPage /> },
      { path: 'llm-provider', element: <LlmProviderPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'guide', element: <GuidePage /> },
    ],
  },
];

/**
 * 使用 HashRouter — 保持与旧版 hash 路由兼容，
 * 避免刷新 404（静态部署不需要服务端 fallback 配置）。
 */
export const router = createHashRouter(routes);
