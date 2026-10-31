import type { AgememContext, HostMessage, LoggerLike, PreStepDecision } from './types.js';
import { extractTurnClaim } from './volatile.js';

/**
 * 资产反思段（task-82）——DSH 侧等价实现，替代 MemoryProxy 的
 * asset-reflection-injector（那里靠 URL marker `/analyse` 触发，见
 * docs/ops/asset-reflection-parity.md）。
 *
 * ## 两扇门
 * 1. 开关：`assetReflection.enabled`（缺省 true）。关掉时整个 section 不注册，
 *    提示词零改动。
 * 2. 触发：当轮**用户文本**出现独立 token `assetReflection.triggerToken`
 *    （缺省 `/analyse`），或 `assetReflection.alwaysOn`（缺省 false，仅评测会话
 *    该打开）。两扇门都开才 emit 块。
 *
 * ## 为什么挂在 systemPrompt.section 而不是追加 user/message
 * 追加消息会落盘成 L0 用户历史（volatile.ts 已实测证明 append 会落盘），
 * 反思要求是系统级指令，不能变成"用户说过的话"。section 的 text 是函数，
 * 每次渲染现取 —— 这正好承载"按轮生效 / 下轮消失"的语义，不需要缓存失效机制。
 *
 * ## 时序
 * 宿主每个 step 先跑 `agent/pre-step`（返回本 step 认领的消息），再渲染提示词、
 * 再调模型（volatile 的注入块就依赖这个顺序）。所以本模块在 pre-step 里读
 * **本 step 认领的用户原文**，把结果写进一个 turn-scoped 标志，section 读它。
 * 同一 turn 的后续 step 认领不到新的用户消息（claim.text === ''），此时**保留**
 * 上一 step 的决定，否则工具调用回合的中途反思段会消失。
 *
 * ## 写回
 * 模型的反思段必须从 L0 剥离：`stripAssetReflection` 在写回前截断，见
 * writeback.ts 的 finalize。标记常量同时进 INJECTION_TEXT_MARKERS 兜底。
 */

export const ASSET_REFLECTION_SECTION_NAME = 'tdb-agemem:asset-reflection';

/**
 * 反思段的起始标记；写回截断与注入兜底都认它。
 *
 * REFLECTION_OPEN 是给 writeback.ts 用的对外名（从这里开始不再是对话正文），
 * ASSET_REFLECTION_MARKER 是本模块沿用的旧名，两者同一字符串。
 */
export const REFLECTION_OPEN = '【资产反思】';
/** 反思段的结束边界（渲染块的闭合标签）；写回按 OPEN 截断即可，CLOSE 供自检。 */
export const REFLECTION_CLOSE = '</asset_reflection>';
export const ASSET_REFLECTION_MARKER = REFLECTION_OPEN;

const OPEN_TAG = '<asset_reflection>';
const CLOSE_TAG = REFLECTION_CLOSE;

/** 缺省 token；与 proxy 的 URL marker 同名，便于两侧口径对照。 */
export const DEFAULT_ASSET_REFLECTION_TOKEN = '/analyse';

/**
 * 文本里是否出现**独立**的 token：前后都不是词字符、`/` 或 `-`。
 * 这样 `/analysed`、`/analyse-x`、路径里的 `a/analyse` 都不算命中，而
 * `请 /analyse 这轮`、`/analyse` 单独成行、`（/analyse）` 都算。
 */
export function hasTriggerToken(text: string, token: string): boolean {
  if (text === '' || token === '') return false;
  const wordish = (ch: string): boolean => ch !== '' && /[\p{L}\p{N}_/-]/u.test(ch);
  let from = 0;
  for (;;) {
    const at = text.indexOf(token, from);
    if (at < 0) return false;
    const before = at === 0 ? '' : text.charAt(at - 1);
    const after = at + token.length >= text.length ? '' : text.charAt(at + token.length);
    if (!wordish(before) && !wordish(after)) return true;
    from = at + token.length;
  }
}

/**
 * 渲染反思块。文案只点 DSH 真实资产：宿主 `skill` 工具 + 插件 `memory_recall`
 * （knowledge 等仍待 task-75）。绝不照抄 proxy 的 `<skill_tools>` /
 * `<tdai_memory_tools>` —— 那两个 tag 在本侧不存在。
 *
 * `maxChars` 是硬上限：超了按整行裁，并补回闭合标签（不留半截 tag）。
 */
export function renderAssetReflectionBlock(maxChars: number): string {
  const lines = [
    OPEN_TAG,
    '**内部效果评估模式**：本次系统提示词挂了可选资产 —— 宿主 skill 工具（加载技能说明）与插件 memory_recall（检索长期记忆：决定、偏好、既往上下文）。',
    '',
    '若本轮你确实调用过其中任一项，请在最终回答**末尾**追加一段复盘，格式固定：',
    ASSET_REFLECTION_MARKER,
    '- skill::<技能名>：这次调用是否起到作用（拿到什么关键信息 / 少走什么弯路 / 为什么没命中）',
    '- memory_recall::<查询意图>：同上',
    '- ……每个调用过的工具一行；同一工具多次调用可合并成一行。',
    '',
    '规则：',
    '- 只复盘本轮**真的调用过**的工具；没调过的一律不列，别猜、别自补。',
    '- 一项都没用时也要写：' + ASSET_REFLECTION_MARKER + '本轮未使用任何记忆或技能资产。',
    '- 简短诚实，没帮上忙也直说 —— 这是接入效果评估，不是好评征集。',
    '- 与主回答用空行 + 「---」分隔；此段仅供内部评估，不构成正式结论。',
    CLOSE_TAG,
  ];
  const text = lines.join(String.fromCharCode(10));
  const budget = Math.max(0, Math.floor(maxChars));
  if (text.length <= budget) return text;
  const keep = Math.max(0, budget - CLOSE_TAG.length - 1);
  const cut = text.slice(0, keep);
  const lastBreak = cut.lastIndexOf(String.fromCharCode(10));
  const head = lastBreak > 0 ? cut.slice(0, lastBreak) : cut;
  return head + String.fromCharCode(10) + CLOSE_TAG;
}

/**
 * 从 assistant 文本里剥掉反思段：从第一个起始标记起整段截断，并去掉因此
 * 留在末尾的分隔线（`---` / `***` / `—`）与空白。
 *
 * 整条只有反思段时返回空串 —— 调用方据此丢弃这条 assistant 消息（写回前
 * 不落 L0），而不是写一条"只有标记"的空话。
 */
export function stripAssetReflection(text: string): string {
  if (typeof text !== 'string' || text === '') return '';
  const at = text.indexOf(ASSET_REFLECTION_MARKER);
  const head = at < 0 ? text : text.slice(0, at);
  const lines = head.split(String.fromCharCode(10));
  while (lines.length > 0) {
    const last = (lines[lines.length - 1] ?? '').trim();
    if (last === '' || /^[-*—_]{3,}$/u.test(last)) {
      lines.pop();
      continue;
    }
    break;
  }
  return lines.join(String.fromCharCode(10)).trim();
}

export interface AssetReflectionDeps {
  enabled: boolean;
  triggerToken: string;
  alwaysOn: boolean;
  maxChars: number;
  /** section 顺序偏移（相对 DEPLOYMENT_PERSONA_SUFFIX），缺省 102（head pack 之后）。 */
  orderOffset?: number;
  log?: LoggerLike;
}

/** 缺省 section 顺序偏移：head pack 是 +100，answer-guidance 是 +101。 */
export const ASSET_REFLECTION_ORDER_OFFSET = 102;

/** 已注册的反思段：pre-step 触发逻辑通过 handle.set 翻开关。 */
export interface AssetReflectionHandle {
  /** 本 turn 是否要注入（pre-step 设定，section 渲染时读）。 */
  active(): boolean;
  /** pre-step 判定结果写入（只由 installAssetReflectionTrigger 调用）。 */
  set(value: boolean): void;
  dispose(): void;
}

/**
 * **只**注册 section（不挂 pre-step）。分两步是为了注册顺序：宿主按 order 排
 * 提示词，但注册顺序决定"最后一个注册的 section"是哪个——既有约定是 head pack
 * 最后注册（见 index.ts 的 guidance 注释），所以反思段必须在 head pack 之前注册；
 * 而 pre-step listener 又必须排在 volatile 之后（见 installAssetReflectionTrigger）。
 * 失败 fail-open：注册不上就只是没有反思段，绝不影响对话。
 */
export function registerAssetReflectionSection(
  ctx: AgememContext,
  deps: AssetReflectionDeps,
): AssetReflectionHandle {
  let active = false;
  const maxChars = Math.max(1, Math.floor(deps.maxChars));
  const set = (value: boolean): void => {
    active = value;
  };
  try {
    const base = ctx.systemPrompt.getSectionOrder?.('DEPLOYMENT_PERSONA_SUFFIX') ?? 10200;
    const dispose = ctx.systemPrompt.section({
      name: ASSET_REFLECTION_SECTION_NAME,
      order: base + (deps.orderOffset ?? ASSET_REFLECTION_ORDER_OFFSET),
      interpolate: false,
      text: () => (active ? renderAssetReflectionBlock(maxChars) : ''),
    });
    return {
      active: () => active,
      set,
      dispose: () => {
        active = false;
        dispose();
      },
    };
  } catch (error) {
    deps.log?.warn?.('agemem: asset-reflection section registration failed; continuing without it', error);
    return { active: () => false, set: () => {}, dispose: () => {} };
  }
}

/**
 * 挂 pre-step 判定，驱动 handle。
 *
 * **注册顺序是契约**：宿主把 agent/pre-step 作为 waterfall 链，每个 listener 拿到的
 * `next` 是链上的下一个。若本 hook prepend 到链头，宿主（和测试 harness，它只驱动
 * 第一个 listener）就会跳过 volatile 的注入 —— 实测 26 个既有用例因此红。所以这里
 * 只 append，并且必须在 installVolatile 之后调用。
 */
export function installAssetReflectionTrigger(
  ctx: AgememContext,
  handle: AssetReflectionHandle,
  deps: AssetReflectionDeps,
): () => void {
  const token = deps.triggerToken === '' ? DEFAULT_ASSET_REFLECTION_TOKEN : deps.triggerToken;
  const onPreStep = async (
    payload: { agent?: unknown; turn?: unknown; step?: unknown; messages?: HostMessage[] },
    next: () => Promise<PreStepDecision>,
  ): Promise<PreStepDecision | undefined> => {
    if (typeof next !== 'function') return undefined;
    const decision = await next();
    try {
      if (!decision || decision.kind === 'reject') return decision;
      const messages = Array.isArray(decision.messages) ? decision.messages : [];
      const claim = extractTurnClaim(messages);
      // 同一 turn 的后续 step 认领不到新的用户消息：保留已定的决定（见文件头）。
      if (claim.text === '') return decision;
      const requested = deps.alwaysOn === true || hasTriggerToken(claim.text, token);
      if (requested !== handle.active()) {
        deps.log?.debug?.('agemem: asset reflection ' + (requested ? 'armed' : 'disarmed'), {
          token,
          alwaysOn: deps.alwaysOn === true,
        });
      }
      handle.set(requested);
      return decision;
    } catch (error) {
      deps.log?.warn?.('agemem: asset-reflection trigger check failed; not injecting', error);
      return decision;
    }
  };
  try {
    return ctx.on('agent/pre-step', onPreStep as any);
  } catch (error) {
    deps.log?.warn?.('agemem: asset-reflection pre-step hook unavailable', error);
    return () => {};
  }
}

/** 便捷封装：section + trigger 一次装好（两者都需要时用；index.ts 分两步装）。 */
export function installAssetReflection(ctx: AgememContext, deps: AssetReflectionDeps): () => void {
  const handle = registerAssetReflectionSection(ctx, deps);
  const disposeTrigger = installAssetReflectionTrigger(ctx, handle, deps);
  return () => {
    disposeTrigger();
    handle.dispose();
  };
}

/** 配置缺省：本模块自持，配置段还没接进 config.ts 时也能直接用。 */
export interface AssetReflectionPolicy {
  enabled: boolean;
  triggerToken: string;
  alwaysOn: boolean;
  maxChars: number;
}

export const DEFAULT_ASSET_REFLECTION_POLICY: AssetReflectionPolicy = {
  enabled: true,
  triggerToken: DEFAULT_ASSET_REFLECTION_TOKEN,
  alwaysOn: false,
  maxChars: 600,
};

/** 渲染块的字符夹取范围（与 volatile 的 maxChars 同一思路：有下限，防截断成空壳）。 */
export const ASSET_REFLECTION_MIN_CHARS = 120;
export const ASSET_REFLECTION_MAX_CHARS = 4000;

function sectionOf(config: unknown): Record<string, unknown> {
  if (!isRecord(config)) return {};
  const nested = config.assetReflection;
  if (isRecord(nested)) return nested;
  // 也接受「直接就是 assetReflection 段」的调用形态，方便测试与独立 harness。
  return config;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 从插件配置里解析 `assetReflection` 段：容忍缺失、类型错、空串、越界，永不抛。
 * 纯函数 —— 独立 harness 与单测都直接调它，不需要真宿主。
 */
export function resolveAssetReflectionPolicy(config?: unknown): AssetReflectionPolicy {
  const raw = sectionOf(config);
  const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_ASSET_REFLECTION_POLICY.enabled;
  const alwaysOn = typeof raw.alwaysOn === 'boolean' ? raw.alwaysOn : DEFAULT_ASSET_REFLECTION_POLICY.alwaysOn;
  const tokenRaw = typeof raw.triggerToken === 'string' ? raw.triggerToken.trim() : '';
  const maxRaw = typeof raw.maxChars === 'number' && Number.isFinite(raw.maxChars)
    ? Math.floor(raw.maxChars)
    : DEFAULT_ASSET_REFLECTION_POLICY.maxChars;
  return {
    enabled,
    triggerToken: tokenRaw === '' ? DEFAULT_ASSET_REFLECTION_POLICY.triggerToken : tokenRaw,
    alwaysOn,
    maxChars: Math.min(ASSET_REFLECTION_MAX_CHARS, Math.max(ASSET_REFLECTION_MIN_CHARS, maxRaw)),
  };
}

/**
 * 接线入口（给 index.ts 的一行调用）：解析配置 → 注册 section → 挂 pre-step。
 *
 * 调用位置有两条约束，都在本函数之外：
 * 1. 必须在 `installVolatile(...)` **之后**调用 —— pre-step 是 waterfall 链，
 *    本 hook 只能排到 volatile 之后（prepend 会成为链头，volatile 的注入就没了）。
 * 2. 若沿用「head pack 是最后注册的 section」这条约定（fake-ctx.sectionText()
 *    取最后一个），请拆成两步：先 registerAssetReflectionSection，再在
 *    installVolatile 之后 installAssetReflectionTrigger。
 *
 * 关闭时返回空 disposer，提示词与 pre-step 都零改动。
 */
export function registerAssetReflection(
  ctx: AgememContext,
  config?: unknown,
  log?: LoggerLike,
): () => void {
  const policy = resolveAssetReflectionPolicy(config);
  if (!policy.enabled) return () => {};
  return installAssetReflection(ctx, { ...policy, log });
}

