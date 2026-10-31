/**
 * api/tasks.ts — Task + ParticipationLog（meta/task/* + meta/task-agent/* + meta/participation-log/*）。
 */
import { getPanelSession } from '../panelSession';
import { metaPost, metaListAll, getCurrentUser, request, ApiError } from './base';
import type { MetaEnvelope } from './types';

export type TaskStatus = 'running' | 'completed';

/**
 * 任务来源（#127）。canonical 口径 = 上游契约：`manual | external | other`。
 *
 * 上游已把 `manual|github|tapd|other` 收窄成这三值，具体外部提供方改读
 * `metadata_json.external.provider`（见 .local/upstream-sync/diffs/
 * MemoryCore_src_gateway_v2-schemas.ts.diff，本地 MemoryCore/src/gateway/
 * v2-schemas.ts:260 尚未跟进，仍是四值 zod）。
 *
 * 因此读侧必须容忍历史/跨版本值：`tapd`/`github`/`jira` 都是"外部系统来源"，
 * 统一归一为 `external`；未知值回落 `manual`（= 旧 adaptTask 的默认行为，
 * 也保证不会因为脏数据让界面出现非法枚举）。
 *
 * 注意：写侧不得主动产出本仓内核还不认的值 —— 本地内核 zod 仍是四值，
 * 送 `external` 会被 400 拒。当前 UI 唯一写入点是 'manual'。
 */
export type TaskSourceType = 'manual' | 'external' | 'other';

/** 把任意历史/跨版本 source_type 归一成 canonical 三值（见上注释）。 */
export function normalizeTaskSourceType(raw: unknown): TaskSourceType {
  if (raw === 'manual' || raw === 'external' || raw === 'other') return raw;
  // 上游收窄前的"外部系统"来源值：语义等价 external（提供方改看 metadata_json.external.provider）
  if (raw === 'tapd' || raw === 'github' || raw === 'jira') return 'external';
  return 'manual';
}

export interface BackendTask {
  task_id: string;
  team_id: string;
  creator_user_id: string;
  title: string;
  description?: string;
  source_type: TaskSourceType;
  source_url?: string;
  status: TaskStatus;
  auto_assign_floating_assets: number;
  risk_level?: 'low' | 'medium' | 'high';
  created_at: string;
  updated_at: string;
  metadata_json: string;
}

export interface BackendTaskAgent {
  id: string;
  task_id: string;
  agent_id: string;
  role_in_task?: string;
  status: 'active' | 'removed';
  created_at: string;
}

export interface BackendTaskWithAgents extends BackendTask {
  agents: BackendTaskAgent[];
}

export const tasksApi = {
  /** 列出 team 下所有 task */
  list: (teamId: string) => metaListAll<BackendTask>('task/list', { team_id: teamId }),

  /** 获取 task 详情（含 linked agents） */
  get: async (taskId: string) => {
    const task = await metaPost<BackendTask>('task/get', { task_id: taskId });
    const agents = await metaListAll<BackendTaskAgent>('task-agent/list', { task_id: taskId });
    return { ...task, agents };
  },

  /**
   * 批量拉取 team 下 task 及其 linked agents（Panel 层聚合接口）。
   *
   * 后端分页：传 limit + offset，Panel 透传给内核 task/list，
   * 内核只返回当前页的 task + 全量 total。Panel 再并行补齐 linked_agents。
   * 前端只拿到当前页的数据，内存和渲染都只处理一页。
   */
  listWithAgents: async (
    teamId: string,
    params?: { limit?: number; offset?: number },
  ): Promise<{ items: BackendTaskWithAgents[]; total: number }> => {
    const session = getPanelSession();
    if (!session) throw new ApiError(401, 'Unauthorized', 'no active panel session');
    const body: Record<string, unknown> = { team_id: teamId };
    if (params?.limit) body.limit = params.limit;
    if (params?.offset != null) body.offset = params.offset;
    const envelope = await request<MetaEnvelope<{ items: BackendTaskWithAgents[]; total: number }>>(
      'POST',
      '/api/v1/task/list-with-agents',
      body,
      {
        'X-Tdai-Service-Id': session.instanceId,
        'X-Tdai-User-Key': session.userKey,
      },
    );
    if (envelope.code !== 0) {
      throw new ApiError(200, envelope.message, '', {
        code: envelope.code,
        requestId: envelope.request_id,
        rawMessage: envelope.message,
      });
    }
    return { items: envelope.data?.items ?? [], total: envelope.data?.total ?? 0 };
  },

  /** 创建 task */
  create: async (
    teamId: string,
    data: {
      title: string;
      description?: string;
      source_type?: TaskSourceType;
      source_url?: string;
      risk_level?: 'low' | 'medium' | 'high';
      linked_agents?: string[];
    },
  ) => {
    const me = await getCurrentUser();
    return metaPost<BackendTask>('task/create', {
      team_id: teamId,
      creator_user_id: me.user_id,
      title: data.title,
      description: data.description,
      source_type: data.source_type ?? 'manual',
      source_url: data.source_url,
      risk_level: data.risk_level,
      linked_agents: data.linked_agents?.map((agent_id) => ({ agent_id })),
    });
  },

  /** 更新 task（title / status / description / risk_level / source_url） */
  update: (
    taskId: string,
    data: Partial<{
      title: string;
      description: string;
      status: TaskStatus;
      risk_level: 'low' | 'medium' | 'high';
      source_url: string;
    }>,
  ) => metaPost<BackendTask>('task/update', { task_id: taskId, ...data }),

  /** 删除 task（meta task/delete，字段为 task_ids 数组） */
  delete: async (taskId: string) => {
    await metaPost<{ deleted_ids: string[] }>('task/delete', { task_ids: [taskId] });
  },

  /** 关联 agent */
  linkAgent: (taskId: string, agentId: string, roleInTask?: string) =>
    metaPost<BackendTaskAgent>('task-agent/link', {
      task_id: taskId,
      agent_id: agentId,
      role_in_task: roleInTask,
    }),

  /** 解除 agent 关联 */
  unlinkAgent: async (taskId: string, agentId: string) => {
    await metaPost<{ ok: boolean }>('task-agent/unlink', { task_id: taskId, agent_id: agentId });
  },
};

// ========================= Participation Logs（meta/participation-log/*）=========================
//
// Session 启动时会 append 一条 (team, task, agent, user) 事件；看板据此
// 展示"实际参与 User / Agent"。语义与 `task-agent/link`（人工声明关系）互补：
//   - `linked_agents` = 意图（谁应该干这个 task）
//   - participation_log = 观测（谁实际起过 session）
//
// 后端 `dedupe:true` 只对 user_id 生效，agent 维度需前端自行 dedupe。

export interface ParticipationLogEntity {
  id?: string;
  team_id: string;
  task_id: string;
  agent_id: string;
  user_id: string;
  source?: string;
  metadata_json?: string;
  created_at?: string;
}

export const participationLogsApi = {
  /**
   * 拉取指定 task 的原始参与日志（不走内核 `dedupe`——它只按 user_id 去重，会丢
   * agent 维度信息）。调用侧按 user_id / agent_id 分别 dedupe 得到两份展示列表。
   */
  listByTask: (teamId: string, taskId: string) =>
    metaListAll<ParticipationLogEntity>('participation-log/list', {
      team_id: teamId,
      task_id: taskId,
    }),

  /**
   * 拉取 team 下所有 task 的原始参与日志。列表页用一次请求覆盖 N 个 task 的
   * 统计数字，避免 fanout；前端按 task_id 分桶后再各自 dedupe。
   */
  listByTeam: (teamId: string) =>
    metaListAll<ParticipationLogEntity>('participation-log/list', {
      team_id: teamId,
    }),
};
