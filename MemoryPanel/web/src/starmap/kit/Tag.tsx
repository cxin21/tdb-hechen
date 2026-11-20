import type { ReactNode } from 'react';
import type { Tone } from './types';

export interface TagProps {
  tone?: Tone;
  children: ReactNode;
  title?: string;
}

/** 徽标。无边框，底色是当前色的 12% 透明度；只在真的需要分类/状态时用。 */
export function Tag({ tone = 'neutral', children, title }: TagProps) {
  return (
    <span className={tone === 'neutral' ? 'stk-tag' : `stk-tag stk-tag--${tone}`} title={title}>
      {children}
    </span>
  );
}
