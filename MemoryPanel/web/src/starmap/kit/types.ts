/** kit 通用类型。tone 只表达语义，不表达「好看」。 */
export type Tone = 'neutral' | 'dim' | 'ink' | 'ok' | 'warn' | 'bad' | 'l0' | 'l1' | 'l2' | 'l3';

/** tone → 圆点 class。neutral 不带修饰，落在默认 --dim2 上。 */
export function dotClass(tone: Tone = 'neutral'): string {
  return tone === 'neutral' ? 'stk-dot' : `stk-dot stk-dot--${tone}`;
}
