import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Segment } from 'tea-component';
import { ResourcePage } from '@/pages/ResourcePage';
import ChatMemoryPanel from './components/ChatMemoryPanel';
import ValueAnchorsPanel from './components/ValueAnchorsPanel';

/**
 * ChatMemoryPage —— 页级视图切换（DS-PANEL-UI-WIKI-SOURCE-001 §2.4，Task 5）：
 * 「记忆」= 原有 ChatMemoryPanel；「价值锚」= ValueAnchorsPanel（S1/C2 路由 UI 化）。
 * 沿用页级 Segment 导航惯例（ChatMemoryPanel 的 scopeTab 同款）。
 */
export function ChatMemoryPage() {
  const { t } = useTranslation();
  const [view, setView] = useState<'memory' | 'anchors'>('memory');
  return (
    <ResourcePage>
      <div className="_memory-page-switch">
        <Segment
          value={view}
          onChange={(v) => setView(v as 'memory' | 'anchors')}
          options={[
            { value: 'memory', text: t('memory.view.memory') },
            { value: 'anchors', text: t('memory.view.anchors') },
          ]}
        />
      </div>
      {view === 'memory' ? <ChatMemoryPanel /> : <ValueAnchorsPanel />}
    </ResourcePage>
  );
}
