/**
 * 人物身份层（person）导出面 —— 2026-11-08 人格系统 v3 阶段 1。
 *
 * 只导出契约与两个入口：`resolvePerson`（谁来）与 `linkMemoryToPersons`（挂谁）。
 * 落库方法在 store 层（`IMemoryStore.upsertSoulPerson` 等），不在这里再包一层。
 */
export { personKeyOf, normalizePersonName, resolvePerson, isUsablePersonHint } from "./resolve.js";
export { linkMemoryToPersons, MAX_PERSONS_PER_MEMORY } from "./link.js";
export type { LinkMemoryInput, LinkedPerson, PersonHint, PersonRole, SoulPerson, SoulPersonUpsert } from "./types.js";
