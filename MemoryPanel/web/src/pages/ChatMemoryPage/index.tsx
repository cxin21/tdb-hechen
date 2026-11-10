import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Segment } from 'tea-component';
import { ResourcePage } from '@/pages/ResourcePage';
import ChatMemoryPanel from './components/ChatMemoryPanel';
import MemoryGraphTab from './components/MemoryGraphTab';
import RecallJournalView from './components/RecallJournalView';

/**
 * ChatMemoryPage —— 页级视图切换（T3 重排 2026-11-07）。
 *
 * 三档页级页签（与 ChatMemoryPanel 的 scopeTab 同款 Segment 惯例）：
 *   记忆块 = 原有 ChatMemoryPanel（块列表 + 选中块详情）；
 *   图谱   = MemoryGraphTab（块选择器 + 只读记忆图，原先埋在 L1 二级视图里）；
 *   回放日志 = RecallJournalView。
 * 三块均一级直达、无嵌套折叠；待裁决/价值锚两档随「自维护、0 人工采纳」退场。
 */
type PageView = 'memory' | 'graph' | 'journal';

export function ChatMemoryPage() {
  const { t } = useTranslation();
  const [view, setView] = useState<PageView>('memory');
  return (
    <ResourcePage>
      <div className="_memory-page-switch">
        <Segment
          value={view}
          onChange={(v) => setView(v as PageView)}
          options={[
            { value: 'memory', text: t('memory.view.memory') },
            { value: 'graph', text: t('memory.view.graph') },
            { value: 'journal', text: t('memory.view.journal') },
          ]}
        />
      </div>
      {/* N6（UI-3.4 NO-GO v2）：记忆视图常挂载+display 隐藏——修复 tab 切换丢失选中实例
          （条件渲染会卸载 ChatMemoryPanel 丢内部态）。图谱/日志按需挂载：Sigma 需要真实
          尺寸，藏在 display:none 里布局会算成 0。 */}
      <div style={{ display: view === 'memory' ? undefined : 'none' }}>
        <ChatMemoryPanel />
      </div>
      {view === 'graph' && <MemoryGraphTab />}
      {view === 'journal' && <RecallJournalView />}
    </ResourcePage>
  );
}
