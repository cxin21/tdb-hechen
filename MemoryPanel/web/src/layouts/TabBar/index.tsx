/**
 * TabBar — 多标签页栏。
 *
 * 使用 Tea Design Token 统一样式。
 */
import { useTranslation } from 'react-i18next';
import { ITEM_ICON, usePageMeta, type PageId } from '@/constants/menu';
import './style.css';

export function TabBar({
  pages,
  activePage,
  onNavigate,
  onClose,
}: {
  pages: PageId[];
  activePage: PageId;
  onNavigate: (id: PageId) => void;
  onClose: (id: PageId) => void;
}) {
  const PAGE_META = usePageMeta();
  const { t } = useTranslation();
  return (
    <div className="_memory-tabbar">
      {pages.map((id) => {
        const meta = PAGE_META[id];
        const isActive = id === activePage;
        return (
          <div
            key={id}
            role="tab"
            tabIndex={0}
            aria-selected={isActive}
            data-guide={`tab-${id}`}
            onClick={() => onNavigate(id)}
            onKeyDown={(e) => {
              // 只响应 tab 自身的键盘事件：内层关闭按钮聚焦时按 Enter/空格，
              // keydown 会冒泡到这里，若不守卫会被当作"激活该 tab"而误导航，
              // 关一个后台 tab 反而跳过去。（#124-B3）
              if (e.target !== e.currentTarget) return;
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onNavigate(id);
              }
            }}
            className={`_memory-tabbar-item${isActive ? ' _memory-tabbar-item--active' : ''}`}
          >
            <span className="_memory-tabbar-icon" aria-hidden="true">
              {ITEM_ICON[id]}
            </span>
            <span className="_memory-tabbar-label">{meta.label}</span>
            {!meta.affix && (
              <button
                type="button"
                aria-label={t('tabbar.close', { label: meta.label })}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(id);
                }}
                className="_memory-tabbar-close"
              >
                <svg
                  viewBox="0 0 12 12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  width="10"
                  height="10"
                  aria-hidden="true"
                >
                  <path d="M3 3l6 6M9 3l-6 6" />
                </svg>
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
