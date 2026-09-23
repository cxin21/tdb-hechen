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
      {view === 'memory' ? (
        <ChatMemoryPanel />
      ) : view === 'journal' ? (
        <RecallJournalView />
      ) : null}
    </ResourcePage>
  );
}
