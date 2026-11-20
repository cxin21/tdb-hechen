/**
 * 测试隔离（Round26）：插件测试会真的走 createPersonaCard 的 recordInjection（不是每个用例都注入 memoryLog），
 * 而 resolveInjectionLogPath 在没有 env 时默认落到 $TDB_DATA_DIR/logs/persona-injection.jsonl ——
 * 本机就是生产证据日志 D:/TDB/data/logs/persona-injection.jsonl。于是夹具会话
 * （s-card / s-tool / s-preset / s-bypass / s1 …）的 card-bound / card-cleared 行会混进生产日志，
 * 抬高 /v3/soul/injection/stats 的 noIdentityRows 与契约脚本的「日志重数」，让测试数据冒充真实注入。
 *
 * 这里把整轮测试的日志固定到系统临时目录；生产路径只能由运维显式设 TDB_PERSONA_LOG 指定。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const current = typeof process.env.TDB_PERSONA_LOG === 'string' ? process.env.TDB_PERSONA_LOG.trim() : '';
if (current === '') {
  process.env.TDB_PERSONA_LOG = join(mkdtempSync(join(tmpdir(), 'dsh-plugin-tests-')), 'persona-injection.jsonl');
}
