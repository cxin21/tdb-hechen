import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Segment } from 'tea-component';
import { ResourcePage } from '@/pages/ResourcePage';
import ChatMemoryPanel from './components/ChatMemoryPanel';
import RecallJournalView from './components/RecallJournalView';

/**
 * ChatMemoryPage —— 页级视图切换（DS-PANEL-UI-WIKI-SOURCE-001 §2.4，Task 5）：
 * 「记忆」= 原有 ChatMemoryPanel；「价值锚」= ValueAnchorsPanel（S1/C2 路由 UI 化）。
 * 沿用页级 Segment 导航惯例（ChatMemoryPanel 的 scopeTab 同款）。
 */
export function ChatMemoryPage() {
  const { t } = useTranslation();
  const [view, setView] = useState<'memory' | 'journal'>('memory');
  return (
    <ResourcePage>
      <div className="_memory-page-switch">
        <Segment
          value={view}
          onChange={(v) => setView(v as 'memory' | 'journal')}
          options={[
            { value: 'memory', text: t('memory.view.memory') },
            { value: 'journal', text: t('memory.view.journal') },
          ]}
        />
      </div>
      {/* N6（UI-3.4 NO-GO v2）：记忆视图常挂载+display 隐藏——修复 tab 切换丢失选中实例（条件渲染会卸载 ChatMemoryPanel 丢内部态）；零新依赖，无组件测试基建故以活体 DOM 双向断言验收 */}
      <div style={{ display: view === 'memory' ? undefined : 'none' }}>
        <ChatMemoryPanel />
      </div>
      {view === 'journal' && <RecallJournalView />}
    </ResourcePage>
  );
}
