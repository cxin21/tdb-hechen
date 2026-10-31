/**
 * dsh Session Init Form — `ask_user_question` tool_call 载体。
 *
 * dsh(deepseek-harness)客户端在 preset 场景(web-app + standard/code/cordis
 * 等 preset)会自动挂 `@deepseek-ai/dsh-tool-ask-user`,给主对话 tools 数组
 * 加一个 `ask_user_question` 工具(见 dsh 源码
 * `packages/interaction/tool-ask-user/src/index.ts`)。
 *
 * proxy 侧的 session-init form 直接复用这个 dsh 原生 tool 名,fake 一个
 * assistant tool_call SSE 让客户端 UI 渲染选项。
 *
 * # 与 workbuddy form 的差异(3 处 shape 差异 + tool name)
 *   - tool_name: `AskUserQuestion` → `ask_user_question`
 *   - multiSelect (camelCase) → multi_select (snake_case)
 *   - 每题必填 `id`(dsh schema 硬约束,echoed in answer)
 *   - 顶层 `questions[]` 一次可发多题(workbuddy/CC 通常单题;这里为对齐 dsh
 *     schema 保留数组结构,单题就一元素数组)
 *
 * # 传输(双协议,由 {@link FormData.protocol} 分派)
 *   - **Anthropic Messages**(dsh v0.2+ 主口径,`POST {baseURL}/v1/messages`):
 *     六事件 tool_use SSE —— message_start → content_block_start →
 *     content_block_delta(input_json_delta) → content_block_stop →
 *     message_delta(stop_reason:"tool_use") → message_stop;non-stream 为单帧
 *     `{type:"message", content:[{type:"tool_use",...}], stop_reason:"tool_use"}`。
 *     形状与 `session/claude-code/form.ts:227-283`(CC 的 AskUserQuestion SSE)
 *     一致,只有 tool name / tool_call id 前缀 / input schema 不同。
 *   - **OpenAI /v1/chat/completions**(v0.1.x 兼容):chunk 1 = role+tool_call
 *     decl / chunk 2 = arguments delta / chunk 3 = finish_reason:tool_calls / DONE
 *   - stream 与否跟请求 `body.stream` 保持一致,两种协议都支持。
 *
 * # anthropic 侧必须发空 thinking 占位
 *   OpenAI 帧里的 `reasoning_content` 占位(见 REASONING_PLACEHOLDER)是为了满足
 *   DeepSeek thinking 模式"tool_calls 轮回带非空 reasoning_content"的硬校验。
 *   Anthropic 分支是**同一校验的另一个入口**:DeepSeek 官方 anthropic 兼容端点在
 *   thinking mode 下要求历史 assistant 必须带 `thinking` block,否则 400
 *   `The content[].thinking in the thinking mode must be passed back to the API`
 *   (依据:`agents/dsh/README.md` §3.6)。proxy 伪造的 assistant 帧下一轮就会变成
 *   "历史",所以这个占位必须无条件带。
 *
 *   签名怎么给:沿用本仓既有的 mem-command 伪响应先例 ——
 *   `MemoryProxy/src/mem-command/response-builder.ts:14` non-stream 用
 *   `{type:"thinking", thinking:"...", signature:""}`,:47-59 streaming 只发
 *   `content_block_start(content_block:{type:"thinking",thinking:""})` +
 *   `thinking_delta` + `content_block_stop`(不发 `signature_delta`)。本文件照抄
 *   该形状,只是 thinking 文本留空(表单帧不该抢用户注意力)。
 *
 *   ⚠️ 未验证项:DeepSeek 端是否接受空串 signature(远端行为,本仓无抓包证据)。
 *   若线上出现上述 400,改这一处(`buildDshThinkingBlock` / 流式的 block 0)即可。
 *
 * # 状态机
 *   - 完全复用 CB 状态机(session/codebuddy/init.ts),同 workbuddy 模式;
 *     stage 值(asset_confirm / team / agent_select / task_select / agent_task)
 *     与 CB 完全一致,直接透传
 *
 * # tool_call id 前缀
 *   - `call_dsh_session_init_` —— 区分于 CB(`call_session_init_`)、
 *     workbuddy(`call_wb_session_init_`)、codex(`fc_codex_session_init_`)
 *
 * # 抓包 schema 依据
 *   - `docs/dsh-recon/fixtures/dsh-tool-catalog-schema.json`
 *   - dsh 源码 `packages/interaction/tool-ask-user/src/index.ts`
 */

import type { TeamOption } from "../types.js";
// dsh (deepseek-harness) 的 ask_user_question UI 无 options 数量上限
// (源码 packages/interaction/tool-ask-user/src/index.ts + UI QuestionComposer.tsx
// 都直接 map 渲染,无截断)。因此 dsh form **不分页**,team/agent/task 全量塞。
// 对比:CC 硬要求 ≤4 options(AskUserQuestion 内部校验),必须分页;codex 有类似
// 限制;CB 无限制也不分页。dsh 属于"UI 无限制"类。
// 详见:MemoryProxy/docs/dsh-recon/2026-08-14-dsh-integration-notes.md 坑 #9。

// ── Constants ──────────────────────────────────────────────────────────────────

/** dsh 原生 tool 名。**不要**改成 CC 的 `AskUserQuestion`——dsh preset 挂的是 snake_case。 */
export const TOOL_NAME = "ask_user_question";
export const TOOLCALL_PREFIX = "call_dsh_session_init_";

export const TEAM_FORM_TITLE = "会话初始化 — 选择 Team";
export const AGENT_TASK_FORM_TITLE = "会话初始化 — 选择 Agent 与任务";
export const RETRY_FORM_TITLE = "未能识别选择,请重新选择";

export const SKIP_LABEL = "本次不关联(跳过注入,直接放行)";
// dsh 不分页,MORE_LABEL 保留仅作向后兼容(测试或未来切分页时用);当前不产出。
export const MORE_LABEL = "更多 →";

/**
 * fake tool_call assistant 消息的占位 reasoning_content。
 *
 * ## 为什么必须非空
 *
 * dsh `serialize.ts:99` 只在 `toolCalls.length > 0 && reasoning.length > 0` 时才
 * 回传 reasoning_content 到上游 body。dsh `translate.ts:133` 入站解析也一样,
 * `reasoning_content.length > 0` 才开一个 reasoning block —— **空串直接吃掉**。
 *
 * 空串 `""` = 客户端解析出 `text: ""` 的 block → serialize join 后 length 0
 * → 上游 body 缺 reasoning_content → deepseek thinking 模式硬校验 400
 * `The reasoning_content in the thinking mode must be passed back to the API`。
 *
 * 塞一个非空占位就能让客户端真开一个 reasoning block,下一轮 replay 时带上。
 * 值本身对模型无影响(反正 fake session-init 也不真过模型)。
 *
 * 见 docs/dsh-recon/2026-08-14-dsh-integration-notes.md 坑 #7。
 */
const REASONING_PLACEHOLDER = "[proxy session-init form]";

/**
 * 轮0 asset_confirm 的两个选项 label。
 *
 * **必须与 CB/CC 侧逐字一致(全角逗号)** —— CB 状态机用
 * `session/claude-code/extractor.ts:58/61` 的 `answerOnly.includes(ASSET_CONFIRM_YES)`
 * 做精准匹配,label 里的标点只要和 extractor 常量差一个字符,用户选完就识别不到,
 * 状态机原地等下一轮 → 表单循环弹。所以这里直接 import 语义一致的全角文案
 * (与 `session/codebuddy/form.ts:29-30` 同字面量)。
 */
export const ASSET_CONFIRM_YES = "是，关联团队资产";
export const ASSET_CONFIRM_NO = "否，本次不关联";
export const ASSET_CONFIRM_FORM_TITLE = "会话初始化 — 是否关联团队资产";

/**
 * 附在每步 question 文末的通用备注：告诉用户"选择跳过 = 本次 session init 跳过、不注入任何团队资产"。
 * dsh 的 ask_user_question UI 也支持 "Other"/自由文本兜底（见 dsh 文档 §3.4
 * `custom` 字段）；回复"跳过 / skip / 不关联"会走 SKIP_RE bypass。
 * 文案与 claude-code/workbuddy/codex/codebuddy 五端统一（此处也一并从半角改为全角标点）。
 */
const SKIP_HINT = '（如选择"跳过"选项，本次 session init 将跳过，不注入任何团队资产）';

/** Returns true if the given string contains any dsh form title marker. */
export function containsFormTitle(s: string): boolean {
  return (
    s.includes(TEAM_FORM_TITLE) ||
    s.includes(AGENT_TASK_FORM_TITLE) ||
    s.includes(RETRY_FORM_TITLE) ||
    s.includes(ASSET_CONFIRM_FORM_TITLE)
  );
}

/** Returns true if a tool_call id belongs to a dsh session-init form. */
export function isSessionInitToolCallId(id: string): boolean {
  return id.startsWith(TOOLCALL_PREFIX);
}

// ── Form Data ──────────────────────────────────────────────────────────────────

export type FormStage = "asset_confirm" | "team" | "agent_select" | "agent_task" | "task_select";

export interface FormData {
  teams: TeamOption[];
  stage: FormStage;
  selectedTeamId?: string;
  selectedAgentId?: string;
  /** @deprecated dsh 不分页(见文件头);字段保留为兼容 session/index.ts dispatch 时透传,builder 忽略。 */
  pageIndex?: number;
  retry?: boolean;
  stream?: boolean;
  modelId?: string;
  /**
   * 入站请求的 wire protocol。dsh v0.2+ 走 Anthropic Messages
   * (`POST {baseURL}/v1/messages`),v0.1.x 走 OpenAI Chat Completions。
   * 由 `session/index.ts` 从 `SessionRequestContext.protocol` 透传
   * (anthropicHandler 传 "anthropic",handler 传 "openai")。
   *
   * 缺省 = "openai"(历史默认,与 `SessionRequestContext.protocol` 注释一致)。
   */
  protocol?: "openai" | "anthropic";
}

// ── ask_user_question input schema (dsh snake_case + 必填 id) ──────────────────

interface DshAskQuestionOption {
  label: string;
  description: string;
}

interface DshAskQuestion {
  /** dsh schema 硬要求,echoed in answer;proxy 生成稳定 id(题目名短标签)。 */
  id: string;
  question: string;
  header: string;
  options: DshAskQuestionOption[];
  /** dsh 是 snake_case,与 CC 的 multiSelect camelCase 不同。 */
  multi_select: boolean;
}

function buildAskUserQuestionArgs(data: FormData): { questions: DshAskQuestion[] } {
  const { teams, stage, selectedTeamId, retry } = data;
  const titlePrefix = retry ? "⚠️ " : "";
  const questions: DshAskQuestion[] = [];

  if (stage === "asset_confirm") {
    questions.push({
      id: "asset_confirm",
      question: titlePrefix + "本次对话是否要关联团队资产?" + SKIP_HINT,
      header: "关联资产",
      options: [
        { label: ASSET_CONFIRM_YES, description: "选择 Team / Agent / Task，注入团队上下文" },
        { label: ASSET_CONFIRM_NO, description: "本次不注入任何内容，直接放行" },
      ],
      multi_select: false,
    });
    return { questions };
  }

  if (stage === "team") {
    // dsh 无 options 数量上限,全量渲染,不分页(见文件头注释)。
    const teamOpts: DshAskQuestionOption[] = teams.map((t) => ({
      label: `${t.team_name} (${t.team_id.slice(-8)})`,
      description: "",
    }));
    if (teamOpts.length < 2) {
      throw new Error(
        `[dsh form] team stage requires ≥2 teams (got ${teamOpts.length}). ` +
          `Caller must auto-select when teams.length === 1.`,
      );
    }
    questions.push({
      id: "team_select",
      question: titlePrefix + "请选择本次会话所属的 Team:" + SKIP_HINT,
      header: "Team",
      options: teamOpts,
      multi_select: false,
    });
    return { questions };
  }

  const team = teams.find((t) => t.team_id === selectedTeamId) ?? teams[0];
  if (!team) return { questions };

  if (stage === "agent_select" || stage === "agent_task") {
    // dsh 无 options 数量上限,全量渲染,不分页。
    const combinedOptions: DshAskQuestionOption[] = team.agents.map((a) => ({
      label: `${a.agent_name} (${a.agent_id.slice(-8)})`,
      description: a.description ?? "",
    }));

    if (combinedOptions.length < 2) {
      throw new Error(
        `[dsh form] agent stage requires ≥2 agents (got ${combinedOptions.length}). ` +
          `Caller must handle single-agent auto-select upstream.`,
      );
    }

    questions.push({
      id: "agent_select",
      question: titlePrefix + `请选择「${team.team_name}」下要使用的 Agent:` + SKIP_HINT,
      header: "Agent",
      options: combinedOptions,
      multi_select: false,
    });
    return { questions };
  }

  if (stage === "task_select") {
    // dsh 无 options 数量上限,全量渲染,不分页。
    // team.tasks[0] 是虚拟 default 任务("本次不关联任务"),源头 unshift 一次,
    // 不分页就不会像旧版每页都出现在开头(踩坑文档 §6 坑 #9)。
    const taskOpts: DshAskQuestionOption[] = team.tasks.map((t) => ({
      label: t.isDefault
        ? t.task_name
        : `${t.task_name} (${t.task_id.slice(-8)})`,
      description: "",
    }));

    if (taskOpts.length < 2) {
      throw new Error(
        `[dsh form] task stage requires ≥2 tasks (got ${taskOpts.length}). ` +
          `Default task should always be prepended by fetchTeamsAndAgents.`,
      );
    }

    questions.push({
      id: "task_select",
      question: titlePrefix + `请选择「${team.team_name}」下要关联的任务:` + SKIP_HINT,
      header: "Task",
      options: taskOpts,
      multi_select: false,
    });
    return { questions };
  }

  return { questions };
}

// ── Form Builder ───────────────────────────────────────────────────────────────

/**
 * Build a dsh `ask_user_question` fake form response.
 *
 * 传输由 {@link FormData.protocol} 分派:
 *   - `"anthropic"`(dsh v0.2+): Anthropic Messages —— stream 走六事件 tool_use
 *     SSE,non-stream 走单帧 message。
 *   - `"openai"` / 缺省(v0.1.x): OpenAI chat/completions。
 * arguments shape 两种协议相同:dsh 原生
 * `{questions: [{id, question, header, options, multi_select}]}`。
 */
export function buildFormResponse(data: FormData): Response {
  const model = data.modelId ?? "unknown";
  const toolCallId = TOOLCALL_PREFIX + Date.now();
  const input = buildAskUserQuestionArgs(data);
  const argsStr = JSON.stringify(input);

  if (data.protocol === "anthropic") {
    // Anthropic message id 用 `msg_` 前缀(上游规范);tool_use id 沿用
    // `call_dsh_session_init_` 前缀 —— 它是 proxy 自己回捞答复的锚点
    // (`session/codebuddy/cleaner.ts` 的 tool_use_id 正则),不能换。
    const msgId = "msg_dsh_session_init_" + Date.now();
    if (data.stream) {
      return buildAnthropicStreamingToolUseResponse(msgId, model, toolCallId, argsStr);
    }
    return buildAnthropicNonStreamingToolUseResponse(msgId, model, toolCallId, argsStr);
  }

  const created = Math.floor(Date.now() / 1000);
  const id = "dsh-session-init-" + Date.now();
  if (data.stream) {
    return buildOpenAIStreamingResponse(id, created, model, toolCallId, argsStr);
  }
  return buildOpenAINonStreamingResponse(id, created, model, toolCallId, argsStr);
}

// ── OpenAI Non-streaming ───────────────────────────────────────────────────────

function buildOpenAINonStreamingResponse(
  id: string,
  created: number,
  model: string,
  toolCallId: string,
  argsStr: string,
): Response {
  return new Response(JSON.stringify({
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: null,
        // deepseek thinking 模式强约束 —— 完整分析见 REASONING_PLACEHOLDER 定义。
        // 关键:必须**非空**,否则客户端 translate.ts:133 遇 `reasoning.length > 0`
        // 判据吃掉,serialize.ts:99 输出侧再判 length 0 → 上游 body 缺字段 → 400。
        reasoning_content: REASONING_PLACEHOLDER,
        tool_calls: [{
          id: toolCallId,
          type: "function",
          function: {
            name: TOOL_NAME,
            arguments: argsStr,
          },
        }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

// ── OpenAI Streaming ───────────────────────────────────────────────────────────

function buildOpenAIStreamingResponse(
  id: string,
  created: number,
  model: string,
  toolCallId: string,
  argsStr: string,
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // Chunk 1: role + tool_call declaration (empty arguments) + reasoning_content
      // reasoning_content 必须**非空**(值 = REASONING_PLACEHOLDER)—— 空串会被
      // dsh translate.ts:133 吃掉,serialize 时不回传,上游 400。
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk", created, model,
        choices: [{
          index: 0,
          delta: {
            role: "assistant",
            content: null,
            reasoning_content: REASONING_PLACEHOLDER,
            tool_calls: [{
              index: 0,
              id: toolCallId,
              type: "function",
              function: { name: TOOL_NAME, arguments: "" },
            }],
          },
          finish_reason: null,
        }],
      })}\n\n`));

      // Chunk 2: arguments delta (whole JSON as single delta)
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk", created, model,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: argsStr },
            }],
          },
          finish_reason: null,
        }],
      })}\n\n`));

      // Chunk 3: finish
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk", created, model,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      })}\n\n`));

      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
  });
}

// ── Anthropic thinking placeholder ────────────────────────────────────────────

/**
 * 空 thinking 占位块(非流式的完整形态)。
 *
 * DeepSeek anthropic 兼容端点在 thinking mode 下硬校验历史 assistant 必须带
 * `thinking` block(见 `agents/dsh/README.md` §3.6 与头注);形状照抄
 * `MemoryProxy/src/mem-command/response-builder.ts:14` 的既有先例。
 */
function buildDshThinkingBlock(): Record<string, unknown> {
  return { type: "thinking", thinking: "", signature: "" };
}

// ── Anthropic non-streaming (tool_use) ─────────────────────────────────────────

/**
 * Anthropic Messages 的单帧假 form 应答。
 *
 * 客户端(dsh v0.2+ 的 anthropic adapter)看到 `stop_reason:"tool_use"` +
 * `content[0].type:"tool_use"` 就渲染 ask_user_question UI,并在下一轮把用户选择
 * 作为 `role:"user"` 的 `tool_result` block(`tool_use_id` = 这里的 id)回传。
 */
function buildAnthropicNonStreamingToolUseResponse(
  msgId: string,
  model: string,
  toolUseId: string,
  argsStr: string,
): Response {
  return new Response(JSON.stringify({
    id: msgId,
    type: "message",
    role: "assistant",
    model,
    content: [
      buildDshThinkingBlock(),
      {
        type: "tool_use",
        id: toolUseId,
        name: TOOL_NAME,
        // 注意:Anthropic 的 tool_use.input 是**对象**(不是 OpenAI 那种 JSON 字符串)。
        input: JSON.parse(argsStr),
      },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

// ── Anthropic streaming SSE (tool_use) ─────────────────────────────────────────

/**
 * Anthropic tool_use 的流式应答:tool input 以 `input_json_delta` 的
 * `partial_json`(JSON **字符串**片段)下发,客户端自己拼接并 JSON.parse。
 *
 * 事件序与 `session/claude-code/form.ts:227-283` 完全一致(六事件 + close);
 * 少任何一个事件都会被严格 SSE parser 判为截断(V12-DSH-SSE-FIX 之后 dsh 的
 * anthropic adapter 对帧形状有强校验,见 server.ts:321-324)。
 */
function buildAnthropicStreamingToolUseResponse(
  msgId: string,
  model: string,
  toolUseId: string,
  argsStr: string,
): Response {
  const encoder = new TextEncoder();
  const sse = (event: string, data: unknown) =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(sse("message_start", {
        type: "message_start",
        message: {
          id: msgId, type: "message", role: "assistant", model,
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }));

      // block 0:空 thinking 占位(见头注「anthropic 侧必须发空 thinking 占位」)
      controller.enqueue(sse("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      }));
      controller.enqueue(sse("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "" },
      }));
      controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index: 0 }));

      // block 1: tool_use(表单本体)
      controller.enqueue(sse("content_block_start", {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: toolUseId, name: TOOL_NAME, input: {} },
      }));

      controller.enqueue(sse("content_block_delta", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: argsStr },
      }));

      controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index: 1 }));

      controller.enqueue(sse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 0 },
      }));

      controller.enqueue(sse("message_stop", { type: "message_stop" }));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
  });
}
