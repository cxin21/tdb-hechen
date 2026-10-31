import { useState, useCallback, useRef, useEffect } from 'react';

/**
 * 可拖拽分割线 hook
 * @param initial  初始宽度 (px)
 * @param min      最小宽度 (px)
 * @param max      最大宽度 (px)
 * @param side     拖拽边：'left' 表示左侧面板宽度可调，'right' 表示右侧面板宽度可调
 */
export function useResizable(
  initial: number,
  min: number,
  max: number,
  side: 'left' | 'right' = 'left',
) {
  const [width, setWidth] = useState(initial);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startW = useRef(0);

  // 拖拽前宿主原有的 body 内联样式快照。直接置空串会把宿主（例如嵌在 iframe
  // 或外部布局里时）原本的 cursor/user-select 一起抹掉，导致拖完一次后整页
  // 交互样式永久改变。（#124-B4）
  const prevBodyStyles = useRef<{ cursor: string; userSelect: string } | null>(
    null,
  );

  const endDrag = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    const prev = prevBodyStyles.current;
    document.body.style.cursor = prev ? prev.cursor : '';
    document.body.style.userSelect = prev ? prev.userSelect : '';
    prevBodyStyles.current = null;
  }, []);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      startX.current = e.clientX;
      startW.current = width;
      if (!prevBodyStyles.current) {
        prevBodyStyles.current = {
          cursor: document.body.style.cursor,
          userSelect: document.body.style.userSelect,
        };
      }
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [width],
  );

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta = e.clientX - startX.current;
      const newW =
        side === 'left'
          ? Math.max(min, Math.min(max, startW.current + delta))
          : Math.max(min, Math.min(max, startW.current - delta));
      setWidth(newW);
    };
    // mouseup 可能落在窗口外（拖到浏览器边框外松手），此时 window 收不到 mouseup；
    // blur 兜底，否则拖拽态与 body 样式会一直卡住。卸载时同理必须收尾。
    const onMouseUp = () => endDrag();
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('blur', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('blur', onMouseUp);
      endDrag();
    };
  }, [min, max, side, endDrag]);

  return { width, onMouseDown };
}
