import type { TaskPayload } from "./types.js";

export interface PipelineTimerMemberContext {
  teamId?: string;
  agentId?: string;
}

export interface ParsedPipelineTimerMember extends PipelineTimerMemberContext {
  sessionId: string;
  timerType: string;
  taskType: TaskPayload["type"];
  priority: number;
  /**
   * False when `timerType` matches none of the known pipeline timers (L1/L2/L3).
   * Such members are leftovers from retired subsystems (e.g. the removed
   * context-offload timers `offload-l15`/`offload-l2`) or plain garbage, and
   * callers must skip them instead of falling back to a `flush` task for a
   * bogus sessionId.
   */
  recognized: boolean;
}

const SCOPED_TIMER_PREFIX = "scope:";

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function classifyTimerType(timerType: string): Pick<ParsedPipelineTimerMember, "taskType" | "priority" | "recognized"> {
  if (timerType.startsWith("L1")) return { taskType: "L1", priority: 0, recognized: true };
  if (timerType.startsWith("L2")) return { taskType: "L2", priority: 1, recognized: true };
  if (timerType.startsWith("L3")) return { taskType: "L3", priority: 2, recognized: true };
  return { taskType: "flush", priority: 0, recognized: false };
}

export function buildPipelineTimerMember(
  sessionId: string,
  timerType: string,
  ctx?: PipelineTimerMemberContext,
): string {
  if (ctx?.teamId && ctx?.agentId) {
    return `${SCOPED_TIMER_PREFIX}team:${encodeURIComponent(ctx.teamId)}|agent:${encodeURIComponent(ctx.agentId)}|session:${encodeURIComponent(sessionId)}:${timerType}`;
  }
  return `${sessionId}:${timerType}`;
}

export function parseProfileSessionTenant(sessionId: string): PipelineTimerMemberContext | undefined {
  const m = sessionId.match(/^profile:team:([^|]+)\|agent:([^|]+)(?:\|session:.+)?$/);
  if (!m) return undefined;
  return { teamId: m[1], agentId: m[2] };
}

export function parsePipelineTimerMember(member: string): ParsedPipelineTimerMember {
  if (member.startsWith(SCOPED_TIMER_PREFIX)) {
    const lastColon = member.lastIndexOf(":");
    if (lastColon > SCOPED_TIMER_PREFIX.length) {
      const timerType = member.slice(lastColon + 1);
      const scope = member.slice(SCOPED_TIMER_PREFIX.length, lastColon);
      const values: Record<string, string> = {};
      for (const part of scope.split("|")) {
        const idx = part.indexOf(":");
        if (idx > 0) values[part.slice(0, idx)] = part.slice(idx + 1);
      }
      const sessionId = values.session ? safeDecodeURIComponent(values.session) : "";
      if (sessionId) {
        const classified = classifyTimerType(timerType);
        return {
          sessionId,
          timerType,
          ...classified,
          ...(values.team ? { teamId: safeDecodeURIComponent(values.team) } : {}),
          ...(values.agent ? { agentId: safeDecodeURIComponent(values.agent) } : {}),
        };
      }
    }
  }

  const lastColon = member.lastIndexOf(":");
  if (lastColon <= 0) {
    return { sessionId: member, timerType: "L1_idle", taskType: "L1", priority: 0, recognized: true };
  }

  const sessionId = member.slice(0, lastColon);
  const timerType = member.slice(lastColon + 1);
  const classified = classifyTimerType(timerType);
  const tenant = parseProfileSessionTenant(sessionId);
  return { sessionId, timerType, ...classified, ...tenant };
}
