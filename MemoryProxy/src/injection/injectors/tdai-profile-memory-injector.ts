import type { AgentContext, AnchorTarget, CacheStrategy, ContextBlock, InjectionHook, HookPriority, PrewarmInput } from "../types.js";
import { HOOK_PRIORITY } from "../types.js";
import { TdaiClient } from "../../tdai/client.js";
import type { TdaiIdentity, TdaiMemoryConfig } from "../../tdai/types.js";
import { getTdaiIdentity } from "../../tdai/identity.js";
import type { CoreSkillConfig } from "../../types.js";
import { getMetadataClient } from "../../meta/client.js";
import { resolveFixedAssetCtxs, type FixedAssetCtx } from "./tdai-fixed-asset.js";

/**
 * L2/L3 注入（按 openclaw / hermes 官方做法重构）：
 *   - L3 (persona) → 注入完整内容（稳定且通常较短，作为长期画像）
 *   - L2 (scenarios) → **只注入 Scene Navigation 索引（路径列表 + summary）**，
 *     不预读全文。LLM 需要细节时主动调 `tdai_read_scene` 工具按 path 拉取。
 *   - 同时附 memory-tools-guide 文案，告诉 LLM 怎么用工具 + 调用上限。
 *
 * 这样可以：
 *   1. 大幅降低首轮 token 消耗（L2 全文经常上千 chars × N 个）
 *   2. 让 LLM 按需取文，而不是被无关的场景污染上下文
 *
 * 跨 agent："自有 + 借入"按 agent 分段；每段下面 L3 + Scene 索引并列。
 *
 * 控制面不可达时降级：仅注入当前 agent 的 L3 + Scene 索引。
 */
export class TdaiProfileMemoryInjector implements InjectionHook {
  id = "tdai-profile-memory-injector";
  point = "system.suffix" as const;
  anchor: AnchorTarget = { slot: "memory", relation: "inside_append" };
  priority: HookPriority = HOOK_PRIORITY.MEMORY + 10;
  description = "Inject TDAI L3 (persona) + L2 scene index (path-only, agent reads via tool)";
  /** L2/L3 profile snapshot is injected once after session registration, like skill listing. */
  cacheStrategy: CacheStrategy = "session_init";

  /**
   * @param baseConfig  starter TdaiClient config; per-request `serviceId` will
   *   be overridden with `session.space_id` in `renderBlocksForContext`. This
   *   config's `serviceId` acts as a fallback when no `space_id` is present.
   * @param coreSkillCfg  kernel gateway config for MetadataClient (fixed-asset
   *   agent resolution).
   */
  constructor(
    private baseConfig: TdaiMemoryConfig,
    private coreSkillCfg: Pick<CoreSkillConfig, "endpoint" | "serviceToken" | "serviceId" | "timeoutMs"> | null = null,
  ) {}

  async execute(ctx: AgentContext): Promise<ContextBlock[]> {
    const caps = ctx.metadata.custom?.assetCapabilities as { chat_memory?: boolean } | undefined;
    if (caps?.chat_memory === false) return [];
    return this.renderBlocksForContext(ctx);
  }

  async prewarm(input: PrewarmInput): Promise<ContextBlock[]> {
    if (input.assetCapabilities?.chat_memory === false) return [];
    return this.renderBlocksForContext(createPrewarmAgentContext(input));
  }

  private async renderBlocksForContext(ctx: AgentContext): Promise<ContextBlock[]> {
    const identity = getTdaiIdentity(ctx.metadata.custom);
    if (!identity) return [];

    const session = (ctx.metadata.custom as any)?.session as { user_key?: string; space_id?: string } | undefined;
    const userKey = session?.user_key;
    // spaceId 来自 session 注册时保存的 URL path 中的 `/proxy/<spaceId>/...`；
    // 用作内核的 `x-tdai-service-id` 头做租户路由。空字符串会被内核拒绝（invalid_user_key）
    // —— caller 已在 session-init 阶段做 bypass 处理。
    const spaceId = session?.space_id ?? "";
    const mc = this.coreSkillCfg && userKey
      ? getMetadataClient(this.coreSkillCfg, spaceId, userKey)
      : null;
    const ctxs = await resolveFixedAssetCtxs(ctx, identity, mc);

    // Build a per-request TdaiClient with the correct tenant. Falls back to
    // baseConfig.serviceId (config value) when spaceId is empty.
    const client = new TdaiClient({
      ...this.baseConfig,
      serviceId: spaceId || this.baseConfig.serviceId,
    });

    // 对每个 agent 独立拉 L3 + L2 索引（不读 L2 全文）
    const groups = await Promise.all(ctxs.map((c) => loadAgentProfile(client, c)));

    // 全部为空 → 仍注入 tools-guide（LLM 可主动 search L1 / 读 L2）
    const hasAnything = groups.some((g) => g.l3 || g.l2Entries.length > 0);
    if (!hasAnything) {
      return [{
        type: "text",
        content: MEMORY_TOOLS_GUIDE,
        metadata: { source: this.id, agentCount: 0, l3Count: 0, l2Count: 0, mode: "tools-only" },
      }];
    }

    const lines: string[] = [
      "<tdai_profile_memory>",
      "以下是 TDAI 为当前 agent 维护的长期工作记忆（自有 + 借入分段；L2 仅给索引，按需用工具读全文）：",
    ];

    let l2TotalCount = 0;
    let l3Count = 0;
    for (const g of groups) {
      if (!g.l3 && g.l2Entries.length === 0) continue;
      const tag = g.ctx.isSelf ? "self" : "imported_from";
      lines.push(
        `<agent name=${JSON.stringify(g.ctx.agentName)} role=${JSON.stringify(tag)} agent_id=${JSON.stringify(g.ctx.agentId)}>`,
      );
      if (g.l3?.content) {
        l3Count++;
        lines.push("<l3_core_memory>", truncate(g.l3.content, 6000), "</l3_core_memory>");
      }
      if (g.l2Entries.length > 0) {
        lines.push("<l2_scene_index>");
        for (const e of g.l2Entries) {
          l2TotalCount++;
          // 索引行：路径 + summary（如果有）；正文用 tool 拉
          if (e.summary) {
            lines.push(`- \`${e.path}\` — ${truncate(e.summary, 200)}`);
          } else {
            lines.push(`- \`${e.path}\``);
          }
        }
        lines.push("</l2_scene_index>");
      }
      lines.push("</agent>");
    }

    lines.push("</tdai_profile_memory>");
    // 紧跟一段 memory-tools-guide，告诉 LLM 三个工具的用法 + 调用上限
    lines.push("");
    lines.push(MEMORY_TOOLS_GUIDE);

    // K 核心记忆稳定块（设计 §3 / spec §6）：把 identity / strict_rule 等 slot
    // 注入稳定区（cache 友好、不毁缓存，session_init 语义）。宁缺毋滥：不注入空块。
    try {
      const coreSlots = await loadCoreMemorySlots(client, identity);
      if (coreSlots.length > 0) {
        const tag = coreSlots[0]?.slot;
        lines.push("");
        lines.push("<core_memory>");
        lines.push("以下是当前 agent 的核心记忆（稳定锚定：身份/关键偏好/严格规则，agent 可维护）：");
        for (const s of coreSlots) {
          lines.push(`<${s.slot}>`);
          lines.push(s.content);
          lines.push(`</${s.slot}>`);
        }
        lines.push("</core_memory>");
        void tag;
      }
    } catch (err) {
      // core 注入失败不阻断主链路
      console.warn("[tdai-profile-memory] core_memory skip:", err instanceof Error ? err.message : String(err));
    }

    // T16（K3）：current_feeling 感受块已从本 injector 拆出 —— 这里是 session_init
    // 稳定缓存路径，prewarm 时 messages=[] → q="" → 感受块恒空落缓存 → 整个会话
    // 冻结（K3 问题链）。感受块改为每轮重算：见 TdaiCurrentFeelingInjector
    // （cacheStrategy="none"，user.before 动态区，当轮真实用户消息）。
    // 本 injector 只保留稳定块：L3/L2 索引 + core_memory（A 项成果，session_init
    // 缓存语义不动）。旧注入路径删除干净 —— 感受块不得再出现在本 injector 的输出里。

    return [
      {
        type: "text",
        content: lines.join("\n"),
        metadata: {
          source: this.id,
          agentCount: groups.length,
          l3Count,
          l2IndexCount: l2TotalCount,
          mode: "index+tools",
        },
      },
    ];
  }
}

function createPrewarmAgentContext(input: PrewarmInput): AgentContext {
  return {
    messages: [],
    tools: [],
    requestParams: {},
    metadata: {
      protocol: "anthropic",
      traceId: `prewarm:${input.keyId}`,
      keyId: input.keyId,
      modelId: "prewarm",
      stream: false,
      agentSource: "session-init",
      custom: { session: input.sessionInfo },
    },
  };
}

/** TTL 缓存的 MemoryCore core_values（B1 单一源；30s，避免每轮注入打一次网关）。 */
const CORE_VALUES_TTL_MS = 30_000;
/** C2：动机方向（valence）随值透传；config.yaml fallback 值无 valence（渲染不出方向行）。 */
type AppraisalValueT = { id: string; label: string; weight: number; valence?: number | null };

/** K 稳定块缓存（60s——core 低频变更，session_init 语义允许稍长缓存）。 */
const CORE_SLOTS_TTL_MS = 60_000;
type CoreSlotT = { slot: string; content: string; source: string; version: number; updated_at: string };

/**
 * P2-T12（K-B4）：缓存按租户分桶 —— 键 = teamId/userId/agentId（JSON 数组序列化）。
 * 原模块级单例缓存（无租户键）在双租户交替注入时会把 A 租户的身份小本本
 * 注入进 B 租户会话（跨租户身份泄漏）。键来源统一用注入时 identity
 * （不 hardcode default —— 与 client 侧 identity 透传同源，见 TdaiClient.isoGateHeaders）。
 *
 * 审查 I-1 修补：键不再用裸 `|` join —— 三元组含 `|` 时可碰撞
 * （(t="a", u="b|c", ag="d") 与 (t="a|b", u="c", ag="d") 同键 → 跨租户缓存命中 =
 * 绕过网关注入对方身份块）。改用 JSON.stringify([...]) 序列化，天然消除分隔符歧义。
 * 并新增 serviceId 维度（TdaiClient 请求时实际使用的 `x-tdai-service-id`，
 * 由注入上下文的 space_id/fallback 决定）—— service 模式下跨 service 实例
 * 不再共享缓存条目。
 */
let _coreValuesCache = new Map<string, { values: AppraisalValueT[]; expiresAt: number }>();
let _coreSlotsCache = new Map<string, { slots: CoreSlotT[]; expiresAt: number }>();

/** 单测用：清空租户分桶缓存（模块级状态隔离）。 */
export function resetCoreTenantCachesForTest(): void {
  _coreValuesCache = new Map();
  _coreSlotsCache = new Map();
}

function coreTenantCacheKey(identity: TdaiIdentity, serviceId?: string): string {
  return JSON.stringify([
    identity.teamId ?? "",
    identity.userId ?? "",
    identity.agentId ?? "",
    serviceId ?? "",
  ]);
}

/**
 * B1 单一源落地：值优先从 MemoryCore core_values 按**当前会话租户**拉（agent 可维护），
 * 空/失败 fallback config.yaml。返回 renderCurrentFeeling 需要的 [{id,label,weight}]。
 * （export 仅为单测可见；P2-T12 起签名带 identity —— 缓存按租户分桶。）
 */
export async function loadAppraisalValues(
  client: TdaiClient,
  identity: TdaiIdentity,
  fallbackCfg?: { values?: AppraisalValueT[] },
): Promise<AppraisalValueT[]> {
  const now = Date.now();
  const key = coreTenantCacheKey(identity, client.serviceId);
  const hit = _coreValuesCache.get(key);
  if (hit && hit.expiresAt > now) return hit.values;
  try {
    const rows = await client.listCoreValues(identity);
    if (rows.length > 0) {
      // C2：valence 透传（null=未判定 → 渲染不出方向行；宁缺毋滥）
      const values = rows.map((v) => ({ id: v.value_id, label: v.label, weight: v.weight, valence: v.valence ?? null }));
      _coreValuesCache.set(key, { values, expiresAt: now + CORE_VALUES_TTL_MS });
      return values;
    }
  } catch { /* fall through to fallback */ }
  return fallbackCfg?.values ?? [];
}

/** K 稳定块：按**当前会话租户**拉 core_memory slots（60s TTL；空/失败 → []，宁缺毋滥）。（export 仅为单测可见。） */
export async function loadCoreMemorySlots(client: TdaiClient, identity: TdaiIdentity): Promise<CoreSlotT[]> {
  const now = Date.now();
  const key = coreTenantCacheKey(identity, client.serviceId);
  const hit = _coreSlotsCache.get(key);
  if (hit && hit.expiresAt > now) return hit.slots;
  try {
    const slots = await client.listCoreMemories(identity);
    if (slots.length > 0) {
      _coreSlotsCache.set(key, { slots, expiresAt: now + CORE_SLOTS_TTL_MS });
      return slots;
    }
  } catch { /* fall through */ }
  return [];
}

/** 记忆使用指南：L0/L1 按需用工具检索（不再自动召回），L3 直注、L2 索引直注。 */
export const MEMORY_TOOLS_GUIDE = `<memory-tools-guide>
## ⚠️ 重要：这不是文档，这是你的可用能力

以下 \`<tdai_memory_tools>\` 中列出的 tdai_memory_search / tdai_conversation_search
等，是**你可以主动调用的能力**（不是仅供参考的文档）。它们通过 **Bash + curl**
使用（见上方 \`<tdai_memory_tools>\` 段里的完整调用说明与 URL）。

**禁止**回答类似"我没有这个工具 / 需要 MCP / 需要斜杠命令"。
**正确做法**：判定需要查记忆时，直接在 Bash 里执行 curl，proxy 会自动注入身份与鉴权。

## 记忆使用规则（遇到以下场景必须先查再答）

L3（persona 长期画像）与 L2 场景索引已直接注入 system。L0/L1 需要用工具主动检索。

### 必须先查记忆再回答的场景（命中任一条即触发工具调用）

1. **用户提及历史/过去/之前**：如 "我之前说过 / 我告诉过你 / 上次 / 你还记不记得 / 我们聊过 / 之前那个"
   → 用 \`tdai_conversation_search\`（L0 原文找具体消息）
2. **用户涉及自己身份/偏好/习惯**：如 "我叫什么 / 我的名字 / 我喜欢 / 我的团队 / 我常用 / 我不喜欢 / 我不允许"
   → 用 \`tdai_memory_search\`（L1 原子记忆查偏好/规则）
3. **用户要求你回忆/找**：如 "回忆一下 / 想起 / 找出 / 有没有关于 X 的记录 / 查我们之前"
   → 直接触发工具，不要凭空回答
4. **答案强依赖历史事实**：如 "那个 bug 我们怎么修的 / 上次方案是啥 / 我们的约定是什么"
   → 关键词化后 \`tdai_memory_search\`

**典型流程**（用户："我叫什么"）：
\`\`\`bash
# Step 1: 先查
curl -sfk -X POST <bridge>/atomic/search \\
  -H 'Content-Type: application/json' -H 'x-conversation-id: <sid>' \\
  -d '{"query": "用户姓名 name 身份", "limit": 5}'
# Step 2: 从 items[].content 里提取答案后回复
# 若为空: 明确告诉用户 "我在记忆里没找到，你叫什么？" —— 不要装作知道
\`\`\`

Windows PowerShell 环境请用（bash 单引号 JSON 内联会被吞，且 \`curl\` 是 Invoke-WebRequest 别名）：
\`\`\`powershell
\$body = '{"query":"用户姓名 name 身份","limit":5}'
\$tmp = Join-Path \$env:TEMP ("pm_{0}.json" -f [guid]::NewGuid()); Set-Content -Path \$tmp -Value \$body -NoNewline -Encoding utf8
curl.exe -sfk -X POST <bridge>/atomic/search -H "Content-Type: application/json" -H "x-conversation-id: <sid>" -d "@\$tmp"; Remove-Item \$tmp
\`\`\`

### 不需要查的场景

- 用户问 "你是谁" / "帮我改代码" / "写个脚本" / 通用编程问题
- 当前会话上下文（同轮消息）里已能回答
- 已经在 \`<l3_core_memory>\` 段落里直接看到答案

### ⚠️ 调用约束

- 每轮 \`tdai_memory_search\` + \`tdai_conversation_search\` **合计 ≤ 3 次**（\`tdai_read_scene\` / \`tdai_scenario_ls\` / \`tdai_atomic_query\` 不计入）
- 检索无果时**明确说明**"我在记忆里没找到 X"，不要幻想
- 同一 L2 path 不要重复读
</memory-tools-guide>`;

interface AgentProfileBundle {
  ctx: FixedAssetCtx;
  l3: { content: string } | null;
  /** L2 索引：仅 path + 可选 summary，**不**读全文。 */
  l2Entries: Array<{ path: string; summary?: string }>;
}

async function loadAgentProfile(client: TdaiClient, c: FixedAssetCtx): Promise<AgentProfileBundle> {
  const tdaiCtx = { teamId: c.teamId, userId: c.userId, agentId: c.agentId, agentName: c.agentName };
  const [l3, l2Entries] = await Promise.all([client.readL3ForCtx(tdaiCtx), client.listL2ForCtx(tdaiCtx)]);
  // L3(persona) 可能在尾部内嵌一份「Scene Navigation」场景索引（plugin 侧 read 会带导航段）。
  // 我们已经单独注入 <l2_scene_index>，必须剥掉 persona 尾部这份，避免 L2 索引重复注入。
  const l3Stripped = l3 ? stripSceneNavigation(l3.content) : "";
  return {
    ctx: c,
    l3: l3Stripped.trim() ? { content: l3Stripped } : null,
    l2Entries: (l2Entries ?? []).map((e) => ({ path: e.path, summary: e.summary })),
  };
}

/**
 * 剥离 persona 尾部的「Scene Navigation (Scene Index)」段。
 * 与 plugin 端 scene-navigation.ts 的 NAV_HEADER 对齐（带或不带前置 `---` 都能命中）。
 */
export function stripSceneNavigation(personaContent: string): string {
  const idx = personaContent.indexOf("## 🗺️ Scene Navigation");
  if (idx === -1) return personaContent;
  // 连同紧邻的 `---` 分隔符与前后空白一起去掉
  let cut = personaContent.slice(0, idx);
  cut = cut.replace(/\s*-{3,}\s*$/, "");
  return cut.trimEnd();
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n...[truncated ${s.length - max} chars]` : s;
}
