/**
 * starmap/state/StarmapProvider.tsx — 单页星图的唯一状态源。
 *
 * 只做三件事：选团队/选 agent/选记忆块；把该块的 L1/L2/L3 与人物拉成星图；对外暴露选中的星点。
 * 数据全部走既有 API（chatMemoryApi / fetchSoulPersons），不新增后端能力、不改表。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { chatMemoryApi, type ChatMemoryBlock } from '@/lib/teamApi';
import { fetchSoulPersons } from '@/lib/api/chat-memory-soul';
import { useBackendStore } from '@/stores/backend';
import { useAuthStore } from '@/stores/auth';
import { useAgents, useTeams } from '@/services';

function emptyLayer(layer: string) {
  return { layer, items: [] as never[], total: 0, limit: 0, offset: 0 };
}
import { buildStarmapGraph, type PersonLike, type StarmapGraph } from '../data/graph';
import type { MapNode } from '../engine/geometry';

const AGENT_KEY = 'tdai-memory.starmap.agent';
const BLOCK_KEY = 'tdai-memory.starmap.block';

function readLocal(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string | null) {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export interface StarmapContextValue {
  teamId: string | null;
  teamName: string;
  teams: Array<{ team_id: string; name: string }>;
  setTeamId: (id: string) => void;
  agents: Array<{ agent_id: string; name: string }>;
  activeAgentId: string | null;
  setActiveAgentId: (id: string | null) => void;
  blocks: ChatMemoryBlock[];
  blocksLoading: boolean;
  activeBlockId: string | null;
  setActiveBlockId: (id: string | null) => void;
  activeBlock: ChatMemoryBlock | null;
  graph: StarmapGraph;
  graphLoading: boolean;
  graphError: string | null;
  refreshGraph: () => void;
  focusId: string | null;
  setFocusId: (id: string | null) => void;
  selected: MapNode | null;
  setSelected: (n: MapNode | null) => void;
}

const Ctx = createContext<StarmapContextValue | null>(null);

const EMPTY: StarmapGraph = {
  nodes: [],
  links: [],
  stats: { l1: 0, l2: 0, l3: 0, persons: 0, days: 0, links: 0, truncated: false },
};

export function StarmapProvider({ children }: { children: ReactNode }) {
  const { teams, activeTeamId, activeTeam } = useTeams();
  const teamId = activeTeamId;
  const auth = useAuthStore((s) => s.auth);
  const userId = auth && typeof auth === 'object' ? auth.user_id : undefined;
  const { agents: rawAgents, loading: agentsLoading } = useAgents(teamId);

  const agents = useMemo(
    () => rawAgents.map((a) => ({ agent_id: a.agent_id, name: a.name })),
    [rawAgents],
  );

  const [activeAgentId, setActiveAgentIdState] = useState<string | null>(() => readLocal(AGENT_KEY));
  const [blocks, setBlocks] = useState<ChatMemoryBlock[]>([]);
  const [blocksLoading, setBlocksLoading] = useState(false);
  const [activeBlockId, setActiveBlockIdState] = useState<string | null>(() => readLocal(BLOCK_KEY));
  const [graph, setGraph] = useState<StarmapGraph>(EMPTY);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [selected, setSelected] = useState<MapNode | null>(null);
  const [nonce, setNonce] = useState(0);
  const blockReq = useRef(0);

  // agent 选择跟随 team 变化校正
  useEffect(() => {
    if (!agents.length) return;
    if (!activeAgentId || !agents.some((a) => a.agent_id === activeAgentId)) {
      setActiveAgentIdState(agents[0].agent_id);
    }
  }, [agents, activeAgentId]);

  useEffect(() => {
    writeLocal(AGENT_KEY, activeAgentId);
  }, [activeAgentId]);

  const setActiveAgentId = useCallback((id: string | null) => {
    setActiveAgentIdState(id);
    setFocusId(null);
    setSelected(null);
  }, []);

  // 记忆块列表：优先取该 agent 的固定资产，没有就退回团队资产
  useEffect(() => {
    if (!teamId) {
      setBlocks([]);
      return;
    }
    let alive = true;
    setBlocksLoading(true);
    const load = async () => {
      try {
        const own = activeAgentId ? ((await chatMemoryApi.agentFixed(activeAgentId)).items ?? []) : [];
        if (!alive) return;
        if (own.length) {
          setBlocks(own);
        } else {
          const teamAssets = (await chatMemoryApi.teamAssets(teamId)).items ?? [];
          if (alive) setBlocks(teamAssets);
        }
      } catch (e) {
        if (alive) {
          setBlocks([]);
          setGraphError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (alive) setBlocksLoading(false);
      }
    };
    void load();
    return () => {
      alive = false;
    };
  }, [teamId, activeAgentId]);

  // 块选择校正
  useEffect(() => {
    if (!blocks.length) {
      if (activeBlockId) setActiveBlockIdState(null);
      return;
    }
    if (!activeBlockId || !blocks.some((b) => b.id === activeBlockId)) {
      const preferred =
        blocks.slice().sort((a, b) => (b.updated_at_ms ?? 0) - (a.updated_at_ms ?? 0))[0] ?? null;
      setActiveBlockIdState(preferred?.id ?? null);
    }
  }, [blocks, activeBlockId]);

  useEffect(() => {
    writeLocal(BLOCK_KEY, activeBlockId);
  }, [activeBlockId]);

  const setActiveBlockId = useCallback((id: string | null) => {
    setActiveBlockIdState(id);
    setFocusId(null);
    setSelected(null);
  }, []);

  // 星图数据：L1/L2/L3 + 人物
  useEffect(() => {
    if (!activeBlockId || !teamId) {
      setGraph(EMPTY);
      return;
    }
    const req = ++blockReq.current;
    let alive = true;
    setGraphLoading(true);
    setGraphError(null);
    const settle = <T,>(p: Promise<T>, fallback: T) =>
      p.catch((e: unknown) => {
        if (alive && req === blockReq.current) {
          console.warn('[starmap] layer failed:', e instanceof Error ? e.message : e);
        }
        return fallback;
      });
    const load = async () => {
      const [l1, l2, l3, persons] = await Promise.all([
        settle(chatMemoryApi.layer(activeBlockId, 'L1', 240), emptyLayer('L1')),
        settle(chatMemoryApi.layer(activeBlockId, 'L2', 80), emptyLayer('L2')),
        settle(chatMemoryApi.layer(activeBlockId, 'L3', 80), emptyLayer('L3')),
        settle(fetchSoulPersons({ teamId, userId, agentId: activeAgentId ?? undefined }), {
          persons: [],
          edges: [],
        }),
      ]);
      if (!alive || req !== blockReq.current) return;
      const personList: PersonLike[] = (persons.persons ?? []).map((p) => ({
        person_key: p.key,
        display_name: p.displayName,
        relation_count: p.relationCount,
      }));
      setGraph(
        buildStarmapGraph({
          l1: l1.items as never[],
          l2: l2.items as never[],
          l3: l3.items as never[],
          persons: personList,
        }),
      );
      setGraphLoading(false);
    };
    void load().catch((e: unknown) => {
      if (!alive || req !== blockReq.current) return;
      setGraphError(e instanceof Error ? e.message : String(e));
      setGraph(EMPTY);
      setGraphLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [activeBlockId, teamId, activeAgentId, nonce]);

  const refreshGraph = useCallback(() => setNonce((n) => n + 1), []);

  const activeBlock = useMemo(
    () => blocks.find((b) => b.id === activeBlockId) ?? null,
    [blocks, activeBlockId],
  );

  const value: StarmapContextValue = useMemo(
    () => ({
      teamId,
      teamName: activeTeam?.name ?? '',
      teams: teams.map((t) => ({ team_id: t.team_id, name: t.name })),
      setTeamId: (id: string) => useBackendStore.getState().setActiveTeamId(id),
      agents,
      activeAgentId,
      setActiveAgentId,
      blocks,
      blocksLoading: blocksLoading || agentsLoading,
      activeBlockId,
      setActiveBlockId,
      activeBlock,
      graph,
      graphLoading,
      graphError,
      refreshGraph,
      focusId,
      setFocusId,
      selected,
      setSelected,
    }),
    [
      teamId,
      activeTeam,
      teams,
      agents,
      activeAgentId,
      setActiveAgentId,
      blocks,
      blocksLoading,
      agentsLoading,
      activeBlockId,
      setActiveBlockId,
      activeBlock,
      graph,
      graphLoading,
      graphError,
      refreshGraph,
      focusId,
      selected,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStarmap(): StarmapContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useStarmap 必须在 StarmapProvider 内使用');
  return v;
}
