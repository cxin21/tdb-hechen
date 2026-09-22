import { describe, expect, it } from 'vitest';
import { mapLayerItem } from '../web/src/pages/ChatMemoryPage/utils/map-layer-item';

/**
 * F-T4-1（任务4 全量展示验收发现，2026-09-22）：mapLayerItem 丢 D-0 七列 +
 * task/team/user/agent/version + sensitivity——内核 atomic/query 出参七字段
 * 实值在场、BFF 透传在场，UI 列表路经此映射被丢弃→属性表 0 列呈现（用户看不到=没做）。
 */
const full = {
  id: 'r1',
  title: 'episodic',
  body: 'x',
  refs: [],
  tags: [],
  created_at: '2026-09-22T01:00:00Z',
  occurred_at: '2026-09-22T01:00:00Z',
  certainty: 'observed',
  source: 'extraction',
  valence: 0.5,
  arousal: 0.4,
  significance: 0.8,
  metadata: { recall_count: 3 },
  task_id: 'default',
  team_id: 'team-kcjjqzkxks',
  user_id: 'usr-kfym3ajzme',
  agent_id: 'agt-kfynybx0ly',
  version: 2,
  scene_name: '场景A',
  priority: 88,
  session_key: 's1',
  session_id: 's1',
  timestamp_str: '2026-09-22T01:00:00Z',
  timestamp_start: '2026-09-22T01:00:00Z',
  timestamp_end: '2026-09-22T02:00:00Z',
  sensitivity: 'none',
} as unknown as Parameters<typeof mapLayerItem>[0];

describe('mapLayerItem 属性全景透传（F-T4-1）', () => {
  it('D-0 七列 + 五归属字段 + sensitivity 全透传', () => {
    const m = mapLayerItem(full);
    expect(m.occurred_at).toBe('2026-09-22T01:00:00Z');
    expect(m.scene_name).toBe('场景A');
    expect(m.priority).toBe(88);
    expect(m.session_key).toBe('s1');
    expect(m.timestamp_str).toBe('2026-09-22T01:00:00Z');
    expect(m.timestamp_end).toBe('2026-09-22T02:00:00Z');
    expect(m.task_id).toBe('default');
    expect(m.team_id).toBe('team-kcjjqzkxks');
    expect(m.user_id).toBe('usr-kfym3ajzme');
    expect(m.agent_id).toBe('agt-kfynybx0ly');
    expect(m.version).toBe(2);
    expect(m.sensitivity).toBe('none');
    expect(m.metadata).toEqual({ recall_count: 3 });
  });

  it('缺失字段不造值（undefined 保持，宁缺毋滥）', () => {
    const m = mapLayerItem({
      id: 'r2',
      title: 'a',
      body: 'b',
      refs: [],
      tags: [],
    } as unknown as Parameters<typeof mapLayerItem>[0]);
    expect(m.scene_name).toBeUndefined();
    expect(m.priority).toBeUndefined();
    expect(m.sensitivity).toBeUndefined();
    expect(m.version).toBeUndefined();
  });
});
