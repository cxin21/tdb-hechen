import { useCallback, useEffect, useRef, type ReactNode } from 'react';

export interface DialogProps {
  title: ReactNode;
  description?: ReactNode;
  /** 视口宽度的上限由 CSS 兜底：min(960px, 90vw)。 */
  width?: number;
  onClose: () => void;
  children?: ReactNode;
  footer?: ReactNode;
}

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * 唯一弹窗。旧 theme/ui.tsx 的 Dialog 只有外观，行为缺失（焦点不陷阱、关掉不还原、
 * Esc 不响应、遮罩可滚动）。这里补齐：Esc / 遮罩点击关闭、Tab 循环、初始焦点、
 * 关闭还原焦点、aria-modal、背景滚动锁。
 */
export function Dialog({ title, description, width, onClose, children, footer }: DialogProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const focusFirst = useCallback(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const first = panel.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel).focus();
  }, []);

  useEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    focusFirst();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const nodes = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (n) => n.offsetParent !== null || n === document.activeElement,
      );
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = prevOverflow;
      returnFocusRef.current?.focus?.();
    };
  }, [focusFirst]);

  return (
    <div
      className="stk-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="stk-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        style={width ? { maxWidth: `min(${width}px, 90vw)` } : undefined}
        ref={panelRef}
        tabIndex={-1}
      >
        <div className="stk-dialog-h">
          <div>
            <h2 className="stk-dialog-title">{title}</h2>
            {description !== undefined ? <p className="stk-dialog-desc">{description}</p> : null}
          </div>
          <button type="button" className="stk-dialog-x" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <div className="stk-dialog-body">{children}</div>
        {footer !== undefined ? <div className="stk-dialog-footer">{footer}</div> : null}
      </div>
    </div>
  );
}
