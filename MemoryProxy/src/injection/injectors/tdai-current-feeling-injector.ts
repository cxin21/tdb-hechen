import type { AgentContext, ContextBlock, HookPriority, InjectionHook } from "../types.js";
import { HOOK_PRIORITY } from "../types.js";
import type { TdaiMemoryConfig } from "../../tdai/types.js";
import { TdaiClient } from "../../tdai/client.js";
import { getTdaiIdentity } from "../../tdai/identity.js";
import { getLastUserMessage, getMessageText } from "../context.js";
import { renderCurrentFeeling, type AppraisalConfig } from "../../knowledge/current-feeling.js";
import { loadAppraisalValues } from "./tdai-profile-memory-injector.js";

/**
 * T16（K3）：current_feeling 每轮解冻注入器（R2/R3 拆分模式，brief 推荐方案 a）。
 *
 * 问题链：原感受块逻辑住在 TdaiProfileMemoryInjector（cacheStrategy="session_init"）
 * 里 → prewarm 时 messages=[] → q="" → renderCurrentFeeling 守卫返回 "" →
 * 感受块恒空落 session_init 缓存 → 主流程命中缓存跳过 execute → 整个会话冻结；
 * 兜底（cache miss）路径注入的也是首问感受且冻结整会话，违反感受设计 §3
 * "每轮由当下语境 vs 价值锚派生"。
 *
 * 拆分职责：
 *   - core_memory 稳定块（identity/strict_rule/core_value，A 项成果）保留在
 *     TdaiProfileMemoryInjector 的 session_init 缓存（cache 友好是设计本意）；
 *   - current_feeling 移入本 injector：cacheStrategy="none"（不被 prewarm 白名单
 *     缓存），每轮 execute 用**当轮真实用户消息**（getLastUserMessage）重算，
 *     注入 user.before 动态区（与 wiki-recall 同层；每轮变化的内容进稳定 system
 *     区本来就是 cache 撕裂源）。
 *
 * 复用：renderCurrentFeeling 算法本体不动（B5 否定词失明是登记的后续项）；
 * loadAppraisalValues 复用 Task 12 的 Map<tenantKey> 租户分桶缓存（B1 单一源 +
 * P2-T12 租户键），不重建。
 *
 * 宁缺毋滥：appraisal 未启用 / 身份缺失 / 值为空 / 未命中价值 → 返回 []（不注入噪音）。
 */
export class TdaiCurrentFeelingInjector implements InjectionHook {
  id = "tdai-current-feeling-injector";
  /** 动态/prepend 区：每轮变化的内容不进稳定 system 区（避免上游 KV cache 撕裂）。 */
  point = "user.before" as const;
  /** 紧跟 wiki-recall（MEMORY+1）之后，感受块落在召回内容之后。 */
  priority: HookPriority = HOOK_PRIORITY.MEMORY + 2;
  description = "Per-turn current_feeling appraisal block (unfrozen from session_init cache, T16/K3)";
  /** 不声明 prewarm；cacheStrategy=none → 永不进入 prewarm 白名单。 */
  cacheStrategy = "none" as const;

  /**
   * @param baseConfig 与 TdaiProfileMemoryInjector 共享同一装配对象
   *   （index.ts tdaiBaseConfig，含 appraisal 配置）；per-request serviceId
   *   用 session.space_id 覆盖（与 profile injector 同源租户路由）。
   */
  constructor(private baseConfig: TdaiMemoryConfig) {}

  async execute(ctx: AgentContext): Promise<ContextBlock[]> {
    const caps = ctx.metadata.custom?.assetCapabilities as { chat_memory?: boolean } | undefined;
    if (caps?.chat_memory === false) return [];

    const appraisalCfg = (this.baseConfig as unknown as { appraisal?: AppraisalConfig }).appraisal;
    const cfgEnabled = appraisalCfg?.enabled ?? false;
    if (!cfgEnabled) return [];

    const identity = getTdaiIdentity(ctx.metadata.custom);
    if (!identity) return [];

    const session = (ctx.metadata.custom as any)?.session as { space_id?: string } | undefined;
    const spaceId = session?.space_id ?? "";
    const client = new TdaiClient({
      ...this.baseConfig,
      serviceId: spaceId || this.baseConfig.serviceId,
    });

    const values = await loadAppraisalValues(client, identity, appraisalCfg);
    if (values.length === 0) return [];

    const lastUser = getLastUserMessage(ctx);
    if (!lastUser) return [];
    const q = getMessageText(lastUser).trim().slice(0, 1000);
    const feeling = renderCurrentFeeling(q, {
      enabled: true,
      firedThreshold: appraisalCfg?.firedThreshold ?? 0.4,
      values,
    });
    if (!feeling) return [];
    return [{ type: "text", content: feeling, metadata: { source: this.id } }];
  }
}
