import { describe, expect, it } from 'vitest';
import { emitMutation, onMutation, resetMutationBusForTest } from '../mutation-bus';
import {
  chatMemoryWriteScopes,
  metaWriteScopes,
  panelWriteScopes,
  skillWriteScopes,
} from '../write-scopes';

describe('mutation-bus', () => {
  it('广播去重后按作用域到达订阅者', () => {
    resetMutationBusForTest();
    const seen: string[][] = [];
    onMutation((s) => seen.push(s));
    emitMutation('wiki', 'wiki', 'code');
    expect(seen).toEqual([['wiki', 'code']]);
  });

  it('退订后不再收到', () => {
    resetMutationBusForTest();
    const seen: string[][] = [];
    const off = onMutation((s) => seen.push(s));
    emitMutation('memory');
    off();
    emitMutation('memory');
    expect(seen).toEqual([['memory']]);
  });

  it('空参数不广播', () => {
    resetMutationBusForTest();
    let n = 0;
    onMutation(() => (n += 1));
    emitMutation();
    expect(n).toBe(0);
  });

  it('订阅方抛错不得污染写路径', () => {
    resetMutationBusForTest();
    let after = 0;
    onMutation(() => {
      throw new Error('cache boom');
    });
    onMutation(() => (after += 1));
    expect(() => emitMutation('skills')).not.toThrow();
    expect(after).toBe(1);
  });
});

describe('write-scopes：只认动作词', () => {
  it('panel 写路径命中，读路径不命中', () => {
    expect(panelWriteScopes('/allocate')).toEqual(['wiki', 'code']);
    expect(panelWriteScopes('/unbind')).toEqual(['wiki', 'code']);
    expect(panelWriteScopes('/wiki/sync')).toEqual(['wiki']);
    expect(panelWriteScopes('/wiki/source/refetch')).toEqual(['wiki']);
    expect(panelWriteScopes('/wiki/raw/write')).toEqual(['wiki']);
    expect(panelWriteScopes('/code-graph/register-meta')).toEqual(['code']);
    // 读
    expect(panelWriteScopes('/wiki/list')).toBeNull();
    expect(panelWriteScopes('/wiki/get')).toBeNull();
    expect(panelWriteScopes('/wiki/graph')).toBeNull();
    expect(panelWriteScopes('/code-graph/search')).toBeNull();
    expect(panelWriteScopes('/agent-fixed')).toBeNull();
  });

  it('chat-memory 只把改数据的 action 当写', () => {
    expect(chatMemoryWriteScopes('allocate')).toEqual(['memory']);
    expect(chatMemoryWriteScopes('set-agent-fixed')).toEqual(['memory']);
    expect(chatMemoryWriteScopes('import')).toEqual(['memory']);
    expect(chatMemoryWriteScopes('layer')).toBeNull();
    expect(chatMemoryWriteScopes('item')).toBeNull();
    expect(chatMemoryWriteScopes('archive')).toBeNull();
    expect(chatMemoryWriteScopes('search')).toBeNull();
  });

  it('skill 只把增删改当写（含改正文与资源）', () => {
    expect(skillWriteScopes('create')).toEqual(['skills']);
    expect(skillWriteScopes('delete')).toEqual(['skills']);
    expect(skillWriteScopes('files/write')).toEqual(['skills']);
    expect(skillWriteScopes('files/remove')).toEqual(['skills']);
    expect(skillWriteScopes('files/read')).toBeNull();
    expect(skillWriteScopes('files')).toBeNull();
    expect(skillWriteScopes('versions')).toBeNull();
    expect(skillWriteScopes('search')).toBeNull();
  });

  it('meta：团队/agent 结构变化全清，设置类写入不清', () => {
    expect(metaWriteScopes('team/create')).toEqual(['all']);
    expect(metaWriteScopes('team/delete')).toEqual(['all']);
    expect(metaWriteScopes('agent/update')).toEqual(['all']);
    expect(metaWriteScopes('team-member/add')).toEqual(['all']);
    // 读
    expect(metaWriteScopes('team/list')).toBeNull();
    expect(metaWriteScopes('agent/get')).toBeNull();
    // 不涉及星图的写
    expect(metaWriteScopes('settings/update')).toBeNull();
  });
});
