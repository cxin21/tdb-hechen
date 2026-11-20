/** vitest 全局桩：组件渲染测试在 node 环境跑，浏览器存储对象不存在。 */
const store = new Map<string, string>();

(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => Array.from(store.keys())[i] ?? null,
  get length() {
    return store.size;
  },
} as Storage;

if (!(globalThis as unknown as { navigator?: { language?: string } }).navigator) {
  (globalThis as unknown as { navigator: { language: string } }).navigator = { language: 'zh-CN' };
}
