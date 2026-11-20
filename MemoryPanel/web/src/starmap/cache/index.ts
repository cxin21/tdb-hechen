/**
 * starmap/cache — 星图取数的唯一入口。
 *
 * 三层：resources（Map+TTL+单飞）→ apiCache（按资源命名的 key/TTL/失效标签）→ useResource（组件钩子）。
 * 组件不要直接调 lib/api；新资源在这里加一个 fetchX，再把 key 规则写进注释。
 */
export { ResourceStore, type ResourceResult, type ResourceOptions, type StoreOptions, type StoreSnapshot, type Lane } from './resources';
export {
  TTL,
  starmapStore,
  cacheKey,
  setCacheUser,
  invalidateStarmap,
  clearStarmapCache,
  fetchMemoryLayer,
  fetchMemoryItem,
  fetchWikiGraph,
  fetchCodeStructure,
  fetchSkillList,
  fetchRecallJournal,
  fetchMemoryNeighbors,
  fetchAtomicPath,
  type CacheCallOptions,
  type MemoryLayerQuery,
  type RecallJournalQuery,
} from './apiCache';
export { useResource, type UseResourceOptions, type UseResourceState } from './useResource';
export { useApiResource, type UseApiResourceOptions, type UseApiResourceState } from './useApiResource';
