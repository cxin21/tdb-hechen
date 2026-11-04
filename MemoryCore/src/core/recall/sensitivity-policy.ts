/**
 * D-3 重设计（2026-11-04 用户定案）：sensitivity = 「不外泄 / 不注入」门。
 *
 * ## 为什么不是降权
 * sensitivity 曾以两个「0 值死乘子」存在（memory.recall.sensitivityPenalty、
 * memory.lifecycle.forgetting.sensitivityBias），缺省与生产都是 0，除徽章外无任何行为。
 * 正确的语义不是「敏感内容排后面」——排后面照样会被注入、被第三方看到——而是
 * **这类内容根本不该出现在会被第三方看到的上下文里**。故本模块只有一个判定：
 * 这一行能不能进本轮注入块。
 *
 * ## 判定规则（标准行为，无配置开关）
 *   - sensitivity 为 none / 缺失 / null（历史行，写入侧已合标 undef→none）→ 任何上下文都注入；
 *   - health / finance / relationship → **只在个人单聊 / 私有上下文注入**；
 *     群聊（group）、团队/多人共享（shared）、显式外发（external）一律拦截；
 *   - 上下文未声明（undefined / 只声明一半 / 运行期脏值）→ **拦截**（fail-closed）：
 *     「证明不了是私有」≠「就是私有」。错误注入的代价是不可撤回的泄露，
 *     错误拦截的代价只是一轮少一条记忆（可显式声明后重放），故安全侧唯一解是拦截；
 *   - 枚举外脏值（如 "secret"）→ 一律拦截并记 blockedBy=unclassified：
 *     写入侧确定性门（record/l1-extractor.ts normalizeSensitivity，非法值裁决为 none）
 *     保证库内只会出现四值，出现第五值说明写入被旁路或库被外部改写——这种行的标注
 *     不可信，既不渲染徽章也不得注入（宁缺毋滥），同时作为数据腐坏信号进 journal。
 *
 * ## 「群聊」信号的仓内真相（为什么不自己猜）
 * 调查结论（2026-11-04）：
 *   - l0_conversations 的 DDL 只有 record_id / session_key / session_id / team_id /
 *     task_id / user_id / agent_id / role / message_text / recorded_at / timestamp
 *     （core/store/sqlite.ts:1137-1151）——**没有会话类型/可见性列**；
 *   - session_key 是宿主透传的不透明 id（dsh-plugin/src/ids.ts:21-32 直接取
 *     session.id，缺省 anon-N），**不带群聊标记**；
 *   - /v3/recall 的请求体只有 query / session_key / user_id（gateway/types.ts:59-63），
 *     也没有会话形态字段。
 * 因此仓内不存在任何「可持久化的确定群聊信号」；唯一确定信号是**调用方在召回边界
 * 显式声明的上下文参数**（performLayeredRecall / RecallRequest 的调用方，即 IM/ESN
 * 侧知道自己处于单聊还是群聊）。故本例把「声明」作为唯一输入，并让未声明落回拦截。
 *
 * ## 接线（本文件不接线，注入链路调用）
 * 对候选池做一次 `partitionBySensitivity(pool, ctx)`：只把 `injectable` 送往注入，
 * 并把 `countBlockedByReason(partition)` 写进 journal（ADR-0025 要求被拦行可观测计数）。
 *
 * 可见性 ctx 由 `audienceOfOwnerScope` 从**候选池归属**推导（不是猜会话形态）：
 *   - 池按 user_id 收窄（store 层 `user_id = ?`）且 userId 不是共享兜底桶 → 池内每一行
 *     都属于这个可验证的用户，本轮上下文只回给本人 ⇒ private；
 *   - userId 缺失 / 落在 `default` 兜底桶 → 池可能混入其他主机或其他人写入的行 ⇒
 *     undeclared（fail-closed，敏感行不注入）。`default` 是多主机共用桶，不能当私有。
 * 这条推导只依赖数据模型（行归属），不依赖"宿主知道自己在单聊/群聊"这种仓外事实。
 * 将来若有群聊/共享面接入召回，由该面在边界显式给出 `{chat:"group"}` / `{sharing:"shared"}`；
 * 仓内当前不存在这样的调用方（见上节取证），故不预留配置字段。
 *
 * 本模块纯函数：零 DB、零时钟、零随机、零副作用，可单测。
 */

/** 本轮注入上下文的可见性（归一后的终态）。 */
export type RecallAudience =
  /** 个人单聊 / 仅本人可见 —— 敏感行唯一放行面 */
  | "private"
  /** 群聊 */
  | "group"
  /** 团队 / 多人共享（含跨用户） */
  | "shared"
  /** 显式外发 / 第三方可见 */
  | "external"
  /** 未声明或声明不完整 */
  | "undeclared";

/**
 * 调用方声明（召回边界唯一确定信号，见模块头注释）。
 * 只有 chat="direct" 且 sharing="private" 同时在场才归一为 private；
 * 少一条即 undeclared → 敏感行拦截。
 */
export interface RecallAudienceContext {
  /** 会话形态：direct=个人单聊；group=群聊。 */
  chat?: "direct" | "group";
  /** 记忆可见范围：private=仅本人；shared=团队/多人；external=第三方可见/外发。 */
  sharing?: "private" | "shared" | "external";
}

/**
 * 白名单式放行常量：**唯一**允许敏感行注入的可见性。
 * 新增可见性默认落在拦截侧——要放行必须显式改这里（单点、需评审）。
 */
export const SENSITIVE_AUDIENCE_ALLOWLIST: readonly RecallAudience[] = ["private"];

/** 敏感性类别（归一后；unclassified = 枚举外脏值，fail-closed）。 */
export type SensitivityClass = "none" | "health" | "finance" | "relationship" | "unclassified";

/** 拦截原因（journal / 排查用；放行时缺省）。 */
export type SensitivityBlockReason =
  /** 群聊上下文 */
  | "group"
  /** 团队 / 多人共享上下文 */
  | "shared"
  /** 显式外发 / 第三方可见 */
  | "external"
  /** 上下文未声明（未传 / 只声明一半 / 脏值） */
  | "undeclared"
  /** 敏感性值不在四值枚举内（标注不可信，一律拦截） */
  | "unclassified"
  /** 可见性不在白名单内（防御分支：白名单若被删项，私有也降级为拦截） */
  | "not-allowlisted"
  /** 派生来源（L2 场景块）里含敏感行 */
  | "derived-sensitive"
  /** 派生来源不可判定（无溯源 / 来源行已全部归档 / 后端不支持溯源查询） */
  | "derived-unknown";

/** 单条裁决结果（不可变的纯数据）。 */
export interface SensitivityDecision {
  /** true = 该行可进入本轮注入块。 */
  injectable: boolean;
  /** 归一后的敏感性类别（none / health / finance / relationship / unclassified）。 */
  sensitivity: SensitivityClass;
  /** 归一后的上下文可见性。 */
  audience: RecallAudience;
  /** 被拦原因；injectable=true 时缺省。 */
  blockedBy?: SensitivityBlockReason;
}

/** 敏感性四值枚举（与 store/soul-columns.ts 单一源对齐）。 */
const KNOWN_CLASSES: readonly SensitivityClass[] = ["none", "health", "finance", "relationship"];

/**
 * 归一 sensitivity 值：大小写/空白不敏感；缺失/null → none；
 * 枚举外非空值 → unclassified（fail-closed，不当通行证）。
 */
export function classifySensitivity(record: { sensitivity?: string | null } | null | undefined): SensitivityClass {
  const raw = record?.sensitivity;
  // 缺失 / null → none：D-3 之前的历史行没有标注，写入侧也保证 undef→none
  if (typeof raw !== "string") return "none";
  const v = raw.trim().toLowerCase();
  if (v === "none" || v === "") {
    // 空串不来自写入侧（normalizeSensitivity 把非法值裁决为 none）→ 视为腐坏，fail-closed
    return v === "" ? "unclassified" : "none";
  }
  return (KNOWN_CLASSES as readonly string[]).includes(v) ? (v as SensitivityClass) : "unclassified";
}

/**
 * 派生来源的敏感画像（L2 场景块 → 它蒸馏过的 L1 行；由 store 侧
 * `getDerivedSensitivityStats` 按 derived_from 边一次聚合）。
 */
export interface DerivedSensitivityStat {
  /** 仍在主表（l1_records）里的去重派生行数；已归档行不计。 */
  targets: number;
  /** 其中 sensitivity 非 none 的去重派生行数。 */
  sensitive: number;
}

/**
 * 派生结论行（L2 场景块）的注入裁决。
 *
 * 场景块摘要不是某一行的原文，是 N 行蒸馏后的聚合——所以判据只能是"它蒸馏过的行里
 * 有没有敏感行，以及能不能证明没有"：
 * - 有敏感来源 ⇒ 与行级同一条白名单（只有 private 放行）
 * - 来源不可判定（无溯源边 / 来源行已全部归档 / 后端不支持）⇒ 按 fail-closed 处理，
 *   **但 private 放行**——可见性已证明为本人私有时，"来源是否含敏感"不再决定能否注入
 *   （行级门仍在，dirty 值另有 unclassified 兜底）；反之在非 private 上下文里，无法
 *   证明干净的聚合块一律不注入（结论层是原文直出，不能赌）。
 */
export function decideDerivedInjection(
  stat: DerivedSensitivityStat | null | undefined,
  context?: RecallAudienceContext | null | undefined,
): { injectable: boolean; audience: RecallAudience; blockedBy?: SensitivityBlockReason } {
  const audience = resolveAudience(context);
  const allowlisted = isAllowlisted(audience);
  if (!stat || !(stat.targets > 0)) {
    return allowlisted
      ? { injectable: true, audience }
      : { injectable: false, audience, blockedBy: "derived-unknown" };
  }
  if (stat.sensitive > 0) {
    return allowlisted
      ? { injectable: true, audience }
      : { injectable: false, audience, blockedBy: "derived-sensitive" };
  }
  return { injectable: true, audience };
}

/** 该记录是否属于敏感内容（none 以外的一切，含 unclassified——fail-closed）。 */
export function isSensitiveRecord(record: { sensitivity?: string | null } | null | undefined): boolean {
  return classifySensitivity(record) !== "none";
}

/**
 * 归一调用方声明 → 可见性终态（deny 优先：越共享越先命中）。
 * 声明不完整/脏值 → undeclared（绝不默认私有）。
 */
export function resolveAudience(
  context?: RecallAudienceContext | null | undefined,
): RecallAudience {
  if (!context || typeof context !== "object") return "undeclared";
  const sharing = (context as { sharing?: unknown }).sharing;
  const chat = (context as { chat?: unknown }).chat;
  // deny 优先：外发 > 共享 > 群聊
  if (sharing === "external") return "external";
  if (sharing === "shared") return "shared";
  if (chat === "group") return "group";
  if (chat === "direct" && sharing === "private") return "private";
  return "undeclared";
}

/** 白名单判定：可见性是否在放行名单内。 */
function isAllowlisted(audience: RecallAudience): boolean {
  return SENSITIVE_AUDIENCE_ALLOWLIST.includes(audience);
}

/**
 * 单条裁决：这一行能否进入本轮注入块。
 * 纯函数；同输入同输出；不读 DB / 配置 / 时钟。
 */
export function decideSensitivityInjection(
  record: { sensitivity?: string | null } | null | undefined,
  context?: RecallAudienceContext | null | undefined,
): SensitivityDecision {
  const sensitivity = classifySensitivity(record);
  const audience = resolveAudience(context);
  // ① 非敏感行：任何上下文都注入
  if (sensitivity === "none") {
    return { injectable: true, sensitivity, audience };
  }
  // ② 枚举外脏值：标注不可信，任何上下文都拦截
  if (sensitivity === "unclassified") {
    return { injectable: false, sensitivity, audience, blockedBy: "unclassified" };
  }
  // ③ 敏感行：仅白名单（private）放行
  if (isAllowlisted(audience)) {
    return { injectable: true, sensitivity, audience };
  }
  // 可见性明确落在拦截侧 → 原因取同名可见性（逐项显式映射，不靠断言强转）
  const blockedBy: SensitivityBlockReason =
    audience === "undeclared"
      ? "undeclared"
      : audience === "group"
        ? "group"
        : audience === "shared"
          ? "shared"
          : audience === "external"
            ? "external"
            : "not-allowlisted";
  return { injectable: false, sensitivity, audience, blockedBy };
}

/** 批量分流结果（保序，便于注入链路直接消费）。 */
export interface SensitivityPartition<T> {
  /** 可注入行（原顺序）。 */
  injectable: T[];
  /** 被拦行 + 原因（原顺序）。 */
  blocked: Array<{ item: T; decision: SensitivityDecision }>;
}

/**
 * 批量分流：一次遍历把候选池切成「可注入 / 被拦」，不改入参、不改顺序。
 * 未声明上下文时，敏感行全数落入 blocked（fail-closed）。
 */
export function partitionBySensitivity<T extends { sensitivity?: string | null }>(
  items: readonly T[],
  context?: RecallAudienceContext | null | undefined,
): SensitivityPartition<T> {
  const injectable: T[] = [];
  const blocked: Array<{ item: T; decision: SensitivityDecision }> = [];
  for (const item of items ?? []) {
    const decision = decideSensitivityInjection(item, context);
    if (decision.injectable) injectable.push(item);
    else blocked.push({ item, decision });
  }
  return { injectable, blocked };
}

/**
 * 按拦截原因计数（journal 可观测位：ADR-0025「被拦行必须可观测计数」）。
 * 只统计非 0 项——全放行时返回空对象，不给 journal 塞噪声。
 */
export function countBlockedByReason(
  partition: Pick<SensitivityPartition<unknown>, "blocked">,
): Partial<Record<SensitivityBlockReason, number>> {
  const counts: Partial<Record<SensitivityBlockReason, number>> = {};
  for (const { decision } of partition.blocked) {
    const reason = decision.blockedBy ?? "unclassified";
    counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return counts;
}

/**
 * 从**候选池归属**推导本轮可见性（召回边界唯一调用点，钩子路与工具路共用）。
 *
 * 判据只有一条事实：这批候选行属于谁。召回池带 userId 时 store 侧按 `user_id = ?` 收窄
 *（core/store/sqlite.ts:5006 / :7003），池里每一行都是该用户的；本轮上下文只回给本人
 * ⇒ `{ chat: "direct", sharing: "private" }`（唯一放行面）。
 * userId 缺失或等于共享兜底桶（`DEFAULT_ISOLATION_ID = "default"`，多主机共用）时，
 * 池里可能有别人写入的行 ⇒ 返回 `undefined`（undeclared，敏感行 fail-closed）。
 *
 * 为什么把 `chat` 钉成 "direct"：本仓没有任何可持久化的群聊信号（模块头注释的三条取证），
 * 召回的输入面也不含会话形态；这里的 "direct" 表达的是"没有共享/群聊声明"，不是对
 * IM 会话形态的断言。真接入群聊面时由该面显式声明 `chat: "group"`，本条推导随之失效
 * （deny 优先，group 会压过这里的 private）。
 */
export function audienceOfOwnerScope(
  scope: { userId?: string | null } | null | undefined,
  sharedBucketId: string,
): RecallAudienceContext | undefined {
  const raw = scope?.userId;
  const userId = typeof raw === "string" ? raw.trim() : "";
  if (!userId) return undefined;
  if (!sharedBucketId) return undefined; // 未给桶名 = 无法判定是否共享 → 不放行
  if (userId === sharedBucketId) return undefined;
  return { chat: "direct", sharing: "private" };
}
