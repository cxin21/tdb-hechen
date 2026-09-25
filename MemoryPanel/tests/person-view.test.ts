/**
 * D-2（2026-09-21）：人物锚专视图纯逻辑 golden（spec §2.6/§6.5 U2-U4 + P2 硬令）。
 * 覆盖：人物筛选（node_type==='person' 且 active）/ attrs 宽松解析 / 方向词映射
 * （personDir：1 趋近 / -1 回避 / 0 中性，与 soul-assembler personDir 同语义）/ 
 * 证据链去重（label+aliases 反查按 record_id 去重且要求 personRefs 命中——
 * 与 VAP handleViewRelated 同口径收敛单一源）。
 */
import { describe, it, expect } from 'vitest';
import { buildPersonRows, directionLabel, collectPersonEvidence, maskSecrets } from '../web/src/pages/SoulPage/person-view';

const anchor = (over: Record<string, unknown> = {}) => ({
  value_id: 'p-1',
  label: '女儿',
  weight: 0.62,
  valence: 1,
  state: 'active',
  node_type: 'person',
  attrs_json: JSON.stringify({ role: '家人', aliases: ['闺女'] }),
  ...over,
});

describe('D-2: buildPersonRows', () => {
  it('只收 active 人物锚（theme/character/retired 排除）', () => {
    const rows = buildPersonRows([
      anchor(),
      anchor({ value_id: 't-1', label: '咖啡', node_type: 'theme' }),
      anchor({ value_id: 'c-1', label: '守诺', node_type: 'character' }),
      anchor({ value_id: 'p-2', label: '老周', state: 'retired' }),
      anchor({ value_id: 't-2', label: '旧库兼容', node_type: undefined, attrs_json: undefined }),
    ]);
    expect(rows.map((r) => r.label)).toEqual(['女儿']);
  });

  it('attrs 解析：role/aliases 透传；损坏 attrs_json 宽松降级 {}（宁缺毋滥）', () => {
    const rows = buildPersonRows([
      anchor({ attrs_json: '{broken' }),
    ]);
    expect(rows[0].role).toBeUndefined();
    expect(rows[0].aliases).toEqual([]);
  });

  it('directionLabel：1→趋近 / -1→回避 / 0→中性 / null→空（personDir 同语义，区别于 theme 审慎）', () => {
    expect(directionLabel(1)).toBe('趋近');
    expect(directionLabel(-1)).toBe('回避');
    expect(directionLabel(0)).toBe('中性');
    expect(directionLabel(null)).toBe('');
  });
});

describe('D-2: collectPersonEvidence', () => {
  it('按 personRefs 命中过滤 + record_id 去重（反查链路单一源）', () => {
    const queries = ['女儿', '闺女'];
    const items = [
      { id: 'a', metadata: { personRefs: ['女儿'] }, body: 'x' },
      { id: 'a', metadata: { personRefs: ['女儿'] }, body: 'dup' },
      { id: 'b', metadata: { personRefs: ['闺女'] }, body: 'y' },
      { id: 'c', metadata: { coreRefs: ['女儿'] }, body: 'not-person' },
      { id: 'd', metadata: {}, body: 'no-refs' },
    ];
    const ev = collectPersonEvidence(items as Array<Record<string, unknown>>, queries);
    expect(ev.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('空 personRefs 全滤（宁缺毋滥）', () => {
    const ev = collectPersonEvidence(
      [{ id: 'z', metadata: { personRefs: [] } }] as Array<Record<string, unknown>>,
      ['女儿'],
    );
    expect(ev).toEqual([]);
  });
});

describe('D-2b (V-02 P0): maskSecrets —— 证据链凭据掩码（用户红线：截图即泄露）', () => {
  it('长 token 掩码中段，保留前 4 后 4', () => {
    const key = 'DEMO-abc123def456ghi789jkl012mno345';
    const out = maskSecrets(`读取配置 key=${key} 并写入`);
    expect(out).toContain('DEMO');
    expect(out).toContain('o345');
    expect(out).not.toContain('def456');
    expect(out).not.toContain(key);
  });

  it('短词与普通 URL 不误伤', () => {
    expect(maskSecrets('访问 https://danbooru.donmai.us 查询 tags')).toBe('访问 https://danbooru.donmai.us 查询 tags');
    expect(maskSecrets('w=0.80 趋近')).toBe('w=0.80 趋近');
  });

  it('显式模式 api_key=xxx / Bearer xxx 掩码', () => {
    expect(maskSecrets('api_key=AbCdEf1234567890123456')).not.toContain('AbCdEf123456');
    expect(maskSecrets('Bearer ZxYwVuTsRqOn987654321')).not.toContain('ZxYwVuTs');
  });
});

describe('V12-PERSONDESC：人物专卡 description 透传（2026-09-25 何晨拍板「全部按建议」）', () => {
  it('buildPersonRows 透传 attrs_json.description；缺省=undefined（宁缺毋滥）', () => {
    const rows = buildPersonRows([
      { value_id: 'p1', label: '何晨', node_type: 'person', state: 'active', weight: 0.8, valence: 1, attrs_json: '{"role":"同事","aliases":[],"description":"测试人物说明一行"}' },
      { value_id: 'p2', label: '无desc', node_type: 'person', state: 'active', weight: 0.5, valence: 0, attrs_json: '{"role":"同事"}' },
    ]);
    expect(rows[0].description).toBe('测试人物说明一行');
    expect(rows[1].description).toBeUndefined();
  });
});
