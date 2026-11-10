/**
 * 记忆挂人（link）—— 2026-11-08 人格系统 v3 阶段 1。
 *
 * 把「这条记忆属于谁 / 谁说的 / 提到了谁」压成 `persons: [{key, role}]`，写进
 * `l1_records.metadata_json.persons`。三条硬规则来自 §3-B / §2：
 *
 *  1. **最多 3 人**，按 subject > speaker > mentioned 顺序截断；
 *  2. **第三方转述不入档**：说话人既不是主体、也不是被明确提到的人时，他不进 persons。
 *     理由：转述是「A 说 B 怎样」，这条记忆的归属是 B（主体），把 A 记成 speaker 会让
 *     A 的档案里长出一条他从未说过的话；A 若确实被点了名，只以 mentioned 记录。
 *  3. **宁可少记**：线索为空、解析失败、store 不具备能力时返回空数组，绝不编造 key。
 *
 * 这个函数只做「解析 + 排序 + 截断」，不做任何文本推断（谁是谁由调用方的抽取结果决定）。
 */

import type { CoreTenant, IMemoryStore } from "../store/types.js";
import { normalizeCoreTenant } from "../store/types.js";
import { isUsablePersonHint, resolvePerson } from "./resolve.js";
import { normalizePersonNameCandidate } from "../record/person-hints.js";
import type { LinkMemoryInput, LinkedPerson, PersonHint, PersonRole, SoulPerson } from "./types.js";

/** 一条记忆最多挂几个人（§2 记忆联动矩阵）。 */
export const MAX_PERSONS_PER_MEMORY = 3;

/** 单条线索解析失败不得阻断 L1 写入：吞掉异常并返回 null。 */
async function tryResolve(
  store: IMemoryStore,
  tenant: CoreTenant,
  hint: PersonHint,
): Promise<SoulPerson | null> {
  try {
    return await resolvePerson(store, tenant, hint);
  } catch {
    return null;
  }
}

/**
 * 过滤掉不可用线索（既无平台 id 也无名字），并剥掉脏名字。
 *
 * 名字是角色词（「用户」「助手」）时不能当名字：模型偶尔把称呼槽填成角色词，
 * 一旦写进 `soul_person.display_name`，面板上就会出现一个叫「用户」的人，
 * 而且它会跟真名行分属两行（生产实测 2026-11-09：`p_b38a137ab63b | 用户 | fields=5`）。
 *
 * 有平台 id 的线索**保留身份锚但剥掉脏名**（`displayName: ""`）：
 * 保留是因为平台 id 是可信的身份证据，剥名是因为那个槽位放的不是名字。
 * 早前这里是「有 id 就原样保留」，结果脏名照样写进了 display_name。
 */
function usableHints(list: PersonHint[] | undefined): PersonHint[] {
  if (!Array.isArray(list)) return [];
  const out: PersonHint[] = [];
  for (const hint of list) {
    if (!isUsablePersonHint(hint)) continue;
    const hasPlatform = typeof hint.platformId === "string" && hint.platformId.trim() !== "";
    const nameOk = normalizePersonNameCandidate(hint.displayName ?? "") !== null;
    if (nameOk) {
      out.push(hint);
      continue;
    }
    if (hasPlatform) out.push({ ...hint, displayName: "" });
  }
  return out;
}

/**
 * 给一条记忆挂人。
 *
 * @param store 具备 soul_person 方法的 store；方法缺失时按「无身份表」降级为内存解析。
 * @param tenant 三租户维度（缺省补 default 桶，与 store 内部同口径）。
 * @param input participants / speaker / mentioned（都可缺省）。
 * @returns `{ persons }` —— 空数组表示「本条记忆不挂人」，调用方此刻**不得**写 `persons` 键。
 */
export async function linkMemoryToPersons(
  store: IMemoryStore,
  tenant: CoreTenant | undefined,
  input: LinkMemoryInput,
): Promise<{ persons: LinkedPerson[] }> {
  const t = normalizeCoreTenant(tenant);
  const persons: LinkedPerson[] = [];
  const seen = new Set<string>();
  const push = (key: string | undefined, role: PersonRole): void => {
    if (!key || seen.has(key) || persons.length >= MAX_PERSONS_PER_MEMORY) return;
    seen.add(key);
    persons.push({ key, role });
  };

  const participantHints = usableHints(input.participants);
  const speakerHint = isUsablePersonHint(input.speaker) ? input.speaker : null;
  const mentionedHints = usableHints(input.mentioned);

  // 说话人先解析：它是「是否转述」判定的另一半。
  const speaker = speakerHint ? await tryResolve(store, t, speakerHint) : null;
  const speakerKey = speaker?.personKey ?? "";

  // 参与者逐个解析（保持输入顺序，便于「第一个非说话人 = 主体」这条规则可预期）。
  const resolvedParticipants: Array<{ person: SoulPerson; hint: PersonHint }> = [];
  for (const hint of participantHints) {
    const person = await tryResolve(store, t, hint);
    if (person) resolvedParticipants.push({ person, hint });
  }

  // 主体的判定：显式标注 role=subject 者 → 第一个不是说话人的参与者 → 第一个参与者。
  // 不按「名字听起来像谁」猜，也不让说话人自动兼任主体（那会把说话人写成 subject）。
  const subject =
    resolvedParticipants.find((x) => x.hint.role === "subject")?.person ??
    resolvedParticipants.find((x) => x.person.personKey !== speakerKey)?.person ??
    resolvedParticipants[0]?.person ??
    null;
  const subjectKey = subject?.personKey ?? "";

  // 转述判定：说话人存在且与主体不是同一人 → 说话人不具备 speaker 资格。
  const relayed = speakerKey !== "" && subjectKey !== "" && speakerKey !== subjectKey;

  // ① 主体
  if (subjectKey !== "") push(subjectKey, "subject");
  // ② 说话人：非转述时才记 speaker。转述时说话人不是这条记忆的归属方（他只是转述者），
  //    按 §3-B「不得入档，只记 mentioned」降级为提及——既不冒充主体，也不凭空消失。
  if (speakerKey !== "" && !relayed && speakerKey !== subjectKey) push(speakerKey, "speaker");
  if (relayed) push(speakerKey, "mentioned");
  // ③ 被提到的人
  for (const hint of mentionedHints) {
    const person = await tryResolve(store, t, hint);
    if (person) push(person.personKey, "mentioned");
  }
  // ④ 其余参与者：既不是主体也不是说话人，视为「被提到」（在场但非主体）
  for (const { person } of resolvedParticipants) {
    if (person.personKey === subjectKey) continue;
    if (person.personKey === speakerKey && !relayed) continue;
    push(person.personKey, "mentioned");
  }

  return { persons };
}
