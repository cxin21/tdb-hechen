import { createSoulPersonProfileTool, createSoulPersonSearchTool } from '../tools.js';
import { registerToolModule } from './registry.js';

/**
 * 人物读面的两个工具：
 *   - `soul_person_search`：名字 → person_key（/v3/soul/person/search）；
 *   - `soul_person_profile`：名字或 key → 九字段 + 关系边（/v3/soul/person）。
 *
 * 都是纯读，不写库；开关跟随 `tools.enabled`：没有单独的配置键，因为这两个
 * 是「查人档案」的整条路，单独关一半只会让另一半变成碰运气。
 */
registerToolModule({
  name: 'person_search',
  enabled: (config) => config.tools.enabled,
  build: ({ client, config, log, sessionId }) => [
    createSoulPersonSearchTool({
      client,
      defaultLimit: config.tools.recallTopK,
      timeoutMs: config.server.requestTimeoutMs,
      log,
      sessionId,
    }),
    createSoulPersonProfileTool({
      client,
      defaultLimit: config.tools.recallTopK,
      timeoutMs: config.server.requestTimeoutMs,
      log,
      sessionId,
    }),
  ],
});
