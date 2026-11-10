/**
 * 路由表定义
 *
 * 单页星图：/ 是常驻画布，/memory /soul /wiki /code /skills /team/* /settings 是六座星门，
 * 都在 StarmapLayout 里以抽屉形式展开（同一条 hash 路由，刷新/分享不丢）。
 *
 * 旧版 ConsoleLayout 与九个页面整体退到 /legacy/*：新壳成熟前，
 * 任何被重画漏掉的操作都还能在旧界面里做完，数据与鉴权链完全共用。
 */
import { createHashRouter, type RouteObject } from 'react-router-dom';
import { ConsoleLayout } from '@/layouts/ConsoleLayout';
import StarmapLayout from '@/starmap/StarmapLayout';
import { StarmapProvider } from '@/starmap/state/StarmapProvider';
import MemoryStation from '@/starmap/stations/MemoryStation';
import SoulStation from '@/starmap/stations/SoulStation';
import WikiStation from '@/starmap/stations/WikiStation';
import CodeStation from '@/starmap/stations/CodeStation';
import SkillsStation from '@/starmap/stations/SkillsStation';
import TeamStation from '@/starmap/stations/TeamStation';
import SettingsStation from '@/starmap/stations/SettingsStation';

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
    element: (
      <StarmapProvider>
        <StarmapLayout />
      </StarmapProvider>
    ),
    children: [
      { index: true, element: null },
      { path: 'memory', element: <MemoryStation /> },
      { path: 'soul', element: <SoulStation /> },
      { path: 'wiki', element: <WikiStation /> },
      { path: 'code', element: <CodeStation /> },
      { path: 'skills', element: <SkillsStation /> },
      { path: 'team/members', element: <TeamStation /> },
      { path: 'team/agents', element: <TeamStation /> },
      { path: 'team/api-keys', element: <TeamStation /> },
      { path: 'settings', element: <SettingsStation /> },
    ],
  },
  {
    path: '/legacy',
    element: <ConsoleLayout />,
    children: [
      { index: true, element: <WikiPage /> },
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
