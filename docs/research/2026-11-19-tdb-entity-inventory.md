# TDB 实体清单与数据结构（当前实现快照）

> 生成时间：2026-11-19 · 来源：代码内 DDL（CREATE TABLE + 幂等 ALTER TABLE ADD COLUMN 合并），非文档推断。
> 覆盖 5 个物理库 / 73 张实体表 + 7 张虚拟表（FTS5 / vec0）。

## 物理库分布

| 物理库 | 文件位置 | 承载 |
|---|---|---|
| 记忆内核 | `{dataDir}/{instance}/vectors.db` | L0/L1 记忆、core_memory、soul_*（人格/事件/人物）、skills、memory_* 审计与提示词 |
| 元数据 | `{baseDir}/tdai_metadata_{id}/metadata.db` | meta_*：用户/团队/Agent/任务/资产/ACL/配置 |
| 知识服务 | `./data/knowledge.db`（`KNOWLEDGE_DB_PATH`） | knowledge_wiki、knowledge_code_graph（+审计）、llm_binding |
| Wiki 索引 | 每个 wiki 目录下 `index.db` | page_meta、graph_edge、source |
| 遥测 | ClickHouse `knowledge_tool_call`（MergeTree） | 工具调用埋点 |

## 虚拟表

| 表 | 类型 | 列 |
|---|---|---|
| l1_vec | vec0 余弦 | record_id(PK), embedding float[dim], updated_time |
| l1_fact_vec | vec0 余弦 | record_id(PK), embedding float[dim], updated_time（事实键平行通道 ADR-0011） |
| l0_vec | vec0 余弦 | record_id(PK), embedding float[dim], recorded_at |
| l1_fts | fts5 | content + L1 元数据列 + soul 8 列（UNINDEXED） |
| l0_fts | fts5 | message_text, message_text_original, record_id, session_key, session_id, team_id, task_id, user_id, agent_id, role, recorded_at, timestamp |
| skill_fts | fts5 | name, description, content + skill_id/team_id/owner_agent_id/task_id/user_id（UNINDEXED） |
| skill_vec | vec0 余弦 | skill_id(PK), embedding float[dim] |

## MemoryCore · metadata.db（13 表）

| 表 | 说明 | 列（名称:类型[标记]） |
|---|---|---|
| `meta_agent_fixed_assets` | 元数据·Agent 固定资产（注入方式/优先级） | id:TEXT[PK]<br>agent_id:TEXT[NN]<br>asset_id:TEXT[NN]<br>asset_type:TEXT[NN]<br>injection_mode:TEXT[NN]<br>priority:INTEGER[NN]<br>created_by:TEXT[NN]<br>created_at:TEXT[NN] |
| `meta_agent_persona` | 元数据·Agent 人格卡（自称/口吻/红线/指纹） | agent_id:TEXT[PK]<br>team_id:TEXT[NN]<br>name:TEXT[NN]<br>pronoun:TEXT[NN]<br>self_image:TEXT[NN]<br>voice:TEXT[NN]<br>purpose:TEXT[NN]<br>traits_json:TEXT[NN]<br>redlines_json:TEXT[NN]<br>schema_version:INTEGER[NN]<br>fingerprint:TEXT[NN]<br>updated_at:TEXT[NN] |
| `meta_agents` | 元数据·Agent 注册 | agent_id:TEXT[PK]<br>team_id:TEXT[NN]<br>owner_user_id:TEXT[NN]<br>name:TEXT[NN]<br>description:TEXT<br>prompt:TEXT<br>visibility:TEXT[NN]<br>status:TEXT[NN]<br>created_at:TEXT[NN]<br>updated_at:TEXT[NN]<br>metadata_json:TEXT[NN] |
| `meta_asset_acl` | 元数据·资产 ACL（主体/权限/效力） | id:TEXT[PK]<br>asset_id:TEXT[NN]<br>subject_type:TEXT[NN]<br>subject_id:TEXT[NN]<br>permission:TEXT[NN]<br>effect:TEXT[NN]<br>granted_by:TEXT[NN]<br>created_at:TEXT[NN]<br>updated_at:TEXT[NN] |
| `meta_assets` | 元数据·资产（类型/来源/版本/可见性/置信/用量） | asset_id:TEXT[PK]<br>team_id:TEXT[NN]<br>asset_type:TEXT[NN]<br>name:TEXT[NN]<br>description:TEXT<br>owner_user_id:TEXT[NN]<br>source_type:TEXT[NN]<br>source_ref:TEXT<br>version:INTEGER[NN]<br>visibility:TEXT[NN]<br>status:TEXT[NN]<br>confidence:REAL<br>expires_at:TEXT<br>last_used_at:TEXT<br>usage_count:INTEGER[NN]<br>content_ref:TEXT<br>created_at:TEXT[NN]<br>updated_at:TEXT[NN]<br>metadata_json:TEXT[NN] |
| `meta_config_params` | 元数据·配置参数（global/user 作用域） | id:INTEGER[PK]<br>scope:TEXT[NN]<br>user_id:TEXT<br>module:TEXT[NN]<br>param_name:TEXT[NN]<br>param_value:TEXT[NN]<br>description:TEXT[NN]<br>created_at:TEXT[NN]<br>updated_at:TEXT[NN] |
| `meta_participation_logs` | 元数据·参与流水 | id:TEXT[PK]<br>team_id:TEXT[NN]<br>task_id:TEXT[NN]<br>agent_id:TEXT[NN]<br>user_id:TEXT[NN]<br>source:TEXT[NN]<br>metadata_json:TEXT[NN]<br>created_at:TEXT[NN]<br>updated_at:TEXT[NN] |
| `meta_task_agents` | 元数据·任务-参与 Agent | id:TEXT[PK]<br>task_id:TEXT[NN]<br>agent_id:TEXT[NN]<br>role_in_task:TEXT<br>status:TEXT[NN]<br>created_at:TEXT[NN] |
| `meta_tasks` | 元数据·任务 | task_id:TEXT[PK]<br>team_id:TEXT[NN]<br>creator_user_id:TEXT[NN]<br>title:TEXT[NN]<br>description:TEXT<br>source_type:TEXT[NN]<br>source_url:TEXT<br>status:TEXT[NN]<br>auto_assign_floating_assets:INTEGER[NN]<br>risk_level:TEXT<br>created_at:TEXT[NN]<br>updated_at:TEXT[NN]<br>metadata_json:TEXT[NN] |
| `meta_team_members` | 元数据·团队成员（角色） | id:TEXT[PK]<br>team_id:TEXT[NN]<br>user_id:TEXT[NN]<br>role:TEXT[NN]<br>joined_at:TEXT[NN]<br>status:TEXT[NN] |
| `meta_teams` | 元数据·团队 | team_id:TEXT[PK]<br>name:TEXT[NN]<br>description:TEXT<br>owner_user_id:TEXT[NN]<br>status:TEXT[NN]<br>created_at:TEXT[NN]<br>updated_at:TEXT[NN]<br>metadata_json:TEXT[NN] |
| `meta_user_keys` | 元数据·用户 API Key | key_id:TEXT[PK]<br>user_id:TEXT[NN]<br>key_value:TEXT[UQ/NN]<br>name:TEXT<br>status:TEXT[NN]<br>is_default:INTEGER[NN]<br>last_used_at:TEXT<br>expires_at:TEXT<br>created_at:TEXT[NN]<br>revoked_at:TEXT<br>metadata_json:TEXT[NN] |
| `meta_users` | 元数据·用户账号（auth_provider/external_id/密码） | user_id:TEXT[PK]<br>password:TEXT<br>auth_provider:TEXT[NN]<br>external_id:TEXT[NN]<br>username:TEXT[NN]<br>display_name:TEXT<br>email:TEXT<br>raw_profile_json:TEXT[NN]<br>status:TEXT[NN]<br>user_type:TEXT[NN]<br>created_at:TEXT[NN]<br>updated_at:TEXT[NN]<br>metadata_json:TEXT[NN] |

## MemoryCore · vectors.db（52 表）

| 表 | 说明 | 列（名称:类型[标记]） |
|---|---|---|
| `core_memory` | 核心记忆槽（slot→content，身份/规则等稳定槽） | slot:TEXT[NN]<br>content:TEXT[NN]<br>source:TEXT[NN]<br>version:INTEGER[NN]<br>updated_at:TEXT[NN]<br>team_id:TEXT[NN]<br>user_id:TEXT[NN]<br>agent_id:TEXT[NN] |
| `embedding_meta` | 向量模型指纹（provider/model/dim），换模型触发重建 | key:TEXT[PK]<br>value:TEXT[NN] |
| `entity_agents` | 实体·Agent | agent_id:TEXT[PK]<br>team_id:TEXT[NN]<br>name:TEXT[NN]<br>description:TEXT<br>prompt:TEXT<br>owner_user_id:TEXT<br>visibility:TEXT[NN]<br>status:TEXT[NN]<br>created_at:TEXT[NN]<br>updated_at:TEXT[NN] |
| `entity_knowledge` | 实体·知识源（wiki/code-graph 服务注册） | knowledge_id:TEXT[PK]<br>type:TEXT[NN]<br>service_url:TEXT[NN]<br>name:TEXT[NN]<br>summary:TEXT<br>team_id:TEXT[NN]<br>agent_id:TEXT[NN]<br>user_id:TEXT<br>repo_url:TEXT<br>branch:TEXT<br>created_at:TEXT[NN]<br>updated_at:TEXT[NN] |
| `entity_tasks` | 实体·任务 | task_id:TEXT[PK]<br>team_id:TEXT[NN]<br>creator_user_id:TEXT[NN]<br>title:TEXT<br>description:TEXT<br>source_type:TEXT[NN]<br>source_url:TEXT<br>status:TEXT[NN]<br>auto_assign_floating_assets:INTEGER[NN]<br>risk_level:TEXT[NN]<br>agent_ids_json:TEXT[NN]<br>user_ids_json:TEXT[NN]<br>created_at:TEXT[NN]<br>updated_at:TEXT[NN] |
| `entity_teams` | 实体·团队 | team_id:TEXT[PK]<br>name:TEXT[NN]<br>description:TEXT<br>owner_user_id:TEXT[NN]<br>user_ids_json:TEXT[NN]<br>agent_ids_json:TEXT[NN]<br>status:TEXT[NN]<br>created_at:TEXT[NN]<br>updated_at:TEXT[NN] |
| `entity_users` | 实体·用户 | user_id:TEXT[PK]<br>name:TEXT[NN]<br>job_description:TEXT<br>team_ids_json:TEXT[NN]<br>task_ids_json:TEXT[NN]<br>owned_agent_ids_json:TEXT[NN]<br>status:TEXT[NN]<br>created_at:TEXT[NN]<br>updated_at:TEXT[NN] |
| `l0_conversations` | L0 原话对话行（role + 原文 + 分类） | record_id:TEXT[PK]<br>session_key:TEXT[NN]<br>session_id:TEXT<br>team_id:TEXT<br>task_id:TEXT<br>user_id:TEXT[NN]<br>agent_id:TEXT[NN]<br>role:TEXT[NN]<br>message_text:TEXT[NN]<br>recorded_at:TEXT<br>timestamp:INTEGER<br>classification:TEXT[NN] |
| `l1_archive` | L1 归档行（原文 JSON + 归档原因） | record_id:TEXT[PK]<br>data:TEXT[NN]<br>archived_at:TEXT[NN]<br>reason:TEXT[NN]<br>team_id:TEXT[NN]<br>user_id:TEXT[NN]<br>agent_id:TEXT[NN] |
| `l1_links` | L1 记录间关系边（类型+强度） | source_id:TEXT[NN]<br>target_id:TEXT[NN]<br>type:TEXT[NN]<br>strength:REAL[NN]<br>created_at:TEXT[NN] |
| `l1_records` | L1 长期记忆行（一条事实/记忆一行），双时态 + 情绪 + 重要度 | record_id:TEXT[PK]<br>content:TEXT[NN]<br>type:TEXT<br>priority:INTEGER<br>scene_name:TEXT<br>session_key:TEXT<br>session_id:TEXT<br>team_id:TEXT<br>task_id:TEXT<br>user_id:TEXT[NN]<br>agent_id:TEXT[NN]<br>version:INTEGER[NN]<br>timestamp_str:TEXT<br>timestamp_end:TEXT<br>created_time:TEXT<br>updated_time:TEXT<br>metadata_json:TEXT<br>source_message_ids:TEXT[NN]<br>occurred_at:TEXT<br>valid_start:TEXT<br>valid_end:TEXT<br>certainty:TEXT<br>valence:REAL<br>arousal:REAL<br>significance:REAL<br>sensitivity:TEXT<br>importance:TINYINT |
| `memory_audit` | 记忆写审计（layer/version/request_id） | audit_id:TEXT[PK]<br>record_id:TEXT[NN]<br>layer:TEXT[NN]<br>action:TEXT[NN]<br>team_id:TEXT<br>agent_id:TEXT<br>user_id:TEXT<br>task_id:TEXT<br>version:INTEGER[NN]<br>updated_at_ms:INTEGER[NN]<br>request_id:TEXT |
| `memory_audit_t12` | 审计迁移/分区副本 | audit_id:TEXT[PK]<br>record_id:TEXT[NN]<br>layer:TEXT[NN]<br>action:TEXT[NN]<br>team_id:TEXT<br>agent_id:TEXT<br>user_id:TEXT<br>task_id:TEXT<br>version:INTEGER[NN]<br>updated_at_ms:INTEGER[NN]<br>request_id:TEXT |
| `memory_generation_refs` | 记忆行→生成批次溯源 | generation_ref_id:TEXT[PK]<br>layer:TEXT[NN]<br>memory_id:TEXT[NN]<br>generation_id:TEXT[NN]<br>generation_log_id:TEXT[NN]<br>generation_log_key:TEXT[NN]<br>memory_prompt_id:TEXT[NN]<br>memory_prompt_version:INTEGER[NN]<br>memory_prompt_source:TEXT[NN]<br>created_at_ms:INTEGER[NN] |
| `memory_prompt_setting_logs` | 提示词设置变更日志 | setting_log_id:TEXT[PK]<br>target_type:TEXT[NN]<br>team_id:TEXT<br>agent_id:TEXT<br>layer:TEXT[NN]<br>action:TEXT[NN]<br>reason:TEXT[NN]<br>before_memory_prompt_id:TEXT<br>after_memory_prompt_id:TEXT<br>operator_id:TEXT<br>operated_at_ms:INTEGER[NN] |
| `memory_prompt_settings` | 提示词绑定设置（团队/Agent/层） | setting_id:TEXT[PK]<br>target_type:TEXT[NN]<br>team_id:TEXT<br>agent_id:TEXT<br>layer:TEXT[NN]<br>memory_prompt_id:TEXT[NN]<br>updated_by:TEXT<br>updated_at_ms:INTEGER[NN] |
| `memory_prompts` | 记忆抽取提示词版本 | memory_prompt_id:TEXT[PK]<br>name:TEXT[NN]<br>layer:TEXT[NN]<br>prompt:TEXT[NN]<br>version:INTEGER[NN]<br>status:TEXT[NN]<br>created_by:TEXT<br>updated_by:TEXT<br>created_at_ms:INTEGER[NN]<br>updated_at_ms:INTEGER[NN] |
| `skills` | 技能（版本链 + head 标记 + manifest + 内容哈希） | row_id:TEXT[PK]<br>skill_id:TEXT[NN]<br>version:INTEGER[NN]<br>is_head:INTEGER[NN]<br>user_id:TEXT[NN]<br>owner_agent_id:TEXT[NN]<br>team_id:TEXT[NN]<br>task_id:TEXT[NN]<br>name:TEXT[NN]<br>description:TEXT[NN]<br>content:TEXT[NN]<br>content_hash:TEXT[NN]<br>manifest_json:TEXT[NN]<br>storage_dir:TEXT[NN]<br>status:TEXT[NN]<br>metadata_json:TEXT[NN]<br>created_at_ms:INTEGER[NN]<br>updated_at_ms:INTEGER[NN] |
| `soul_calibration` | 置信校准记录（预测 vs 实际 + 误差） | id:TEXT[PK]<br>team_id:TEXT[NN]<br>user_id:TEXT[NN]<br>agent_id:TEXT[NN]<br>domain:TEXT[NN]<br>predicted_confidence:REAL[NN]<br>actual_outcome:TEXT[NN]<br>event_id:TEXT<br>at:TEXT[NN]<br>error:REAL<br>note:TEXT[NN] |
| `soul_dilemma` | 两难抉择记录（冲突/选择/后悔度/复盘） | id:TEXT[PK]<br>team_id:TEXT[NN]<br>user_id:TEXT[NN]<br>agent_id:TEXT[NN]<br>at:TEXT[NN]<br>conflict_json:TEXT[NN]<br>choice:TEXT[NN]<br>reason:TEXT[NN]<br>regret:REAL[NN]<br>outcome_event_id:TEXT<br>review_at:TEXT |
| `soul_emotions` | 情绪评估结果（模板版本、八维 appraisal） | episode_id:TEXT[NN]<br>team_id:TEXT[NN]<br>user_id:TEXT[NN]<br>agent_id:TEXT[NN]<br>at:TEXT[NN]<br>object:TEXT[NN]<br>label:TEXT[NN]<br>valence:REAL[NN]<br>arousal:REAL[NN]<br>dominance:REAL<br>intensity:REAL[NN]<br>appraisal_json:TEXT<br>template_version:TEXT[NN]<br>appraised_at:TEXT[NN]<br>agency:TEXT<br>confidence:REAL<br>object_person:TEXT<br>event_id:TEXT<br>goal_id:TEXT<br>dimensions_json:TEXT |
| `soul_episodes` | 情节/事件卡（人物、立场、代价、结果、情绪） | episode_id:TEXT[PK]<br>team_id:TEXT[NN]<br>user_id:TEXT[NN]<br>agent_id:TEXT[NN]<br>at:TEXT[NN]<br>day:TEXT[NN]<br>kind:TEXT[NN]<br>title:TEXT[NN]<br>object:TEXT[NN]<br>participants_json:TEXT<br>user_stance:TEXT[NN]<br>agent_stance:TEXT[NN]<br>cost:TEXT[NN]<br>outcome:TEXT[NN]<br>valence:REAL[NN]<br>arousal:REAL[NN]<br>intensity:REAL[NN]<br>affect_source:TEXT[NN]<br>evidence_json:TEXT<br>session_id:TEXT[NN]<br>quote_json:TEXT<br>signals_json:TEXT<br>layers_json:TEXT<br>archived_at:TEXT<br>mood_integrated_at:TEXT<br>persons_json:TEXT |
| `soul_event_action` | 事件·动作副表（工具/参数摘要/耗时/结果） | event_id:TEXT[PK]<br>tool:TEXT[NN]<br>tool_call_id:TEXT<br>args_digest:TEXT<br>result_status:TEXT[NN]<br>duration_ms:INTEGER<br>artifact_ref:TEXT<br>error_code:TEXT<br>environment:TEXT<br>verified_by:TEXT |
| `soul_event_chat` | 事件·对话副表（立场/代价/情绪三维） | event_id:TEXT[PK]<br>kind:TEXT[NN]<br>title:TEXT[NN]<br>user_stance:TEXT[NN]<br>agent_stance:TEXT[NN]<br>cost:TEXT[NN]<br>valence:REAL[NN]<br>arousal:REAL[NN]<br>intensity:REAL[NN]<br>affect_source:TEXT[NN]<br>quote_json:TEXT<br>signals_json:TEXT<br>layers_json:TEXT<br>mood_integrated_at:TEXT |
| `soul_event_evidence` | 事件证据（记录片段引用 + 角色） | event_id:TEXT[NN]<br>record_id:TEXT[NN]<br>role:TEXT[NN]<br>quote:TEXT[NN]<br>at:TEXT[NN]<br>confidence:REAL[NN] |
| `soul_event_reflection` | 事件·反思副表（教训/行为改变） | event_id:TEXT[PK]<br>about_event_ids_json:TEXT[NN]<br>lesson:TEXT[NN]<br>behavior_change:TEXT[NN]<br>verified_at:TEXT<br>confidence:REAL[NN] |
| `soul_events` | Soul 事件主表（actor/action/object/intent/outcome + 双时态） | event_id:TEXT[PK]<br>team_id:TEXT[NN]<br>user_id:TEXT[NN]<br>agent_id:TEXT[NN]<br>at:TEXT[NN]<br>day:TEXT[NN]<br>valid_from:TEXT[NN]<br>valid_to:TEXT<br>actor:TEXT[NN]<br>actor_person_key:TEXT<br>action:TEXT[NN]<br>object:TEXT[NN]<br>intent:TEXT[NN]<br>outcome:TEXT[NN]<br>status:TEXT[NN]<br>source_kind:TEXT[NN]<br>source_ref:TEXT[NN]<br>ownership:TEXT[NN]<br>epistemic:TEXT[NN]<br>confidence:REAL[NN]<br>visibility:TEXT[NN]<br>session_id:TEXT[NN]<br>persons_json:TEXT<br>parent_event_id:TEXT<br>dedupe_key:TEXT<br>salience:REAL[NN]<br>created_at:TEXT[NN]<br>archived_at:TEXT |
| `soul_gate_log` | 门闸决策日志（stage/rule/decision） | id:TEXT[PK]<br>team_id:TEXT[NN]<br>user_id:TEXT[NN]<br>agent_id:TEXT[NN]<br>at:TEXT[NN]<br>stage:TEXT[NN]<br>action_digest:TEXT[NN]<br>rule_id:TEXT<br>decision:TEXT[NN]<br>reason:TEXT[NN]<br>event_id:TEXT<br>confidence:REAL[NN] |
| `soul_gate_stats` | 门闸命中统计（code/layer/日计数） | team_id:TEXT[NN]<br>user_id:TEXT[NN]<br>agent_id:TEXT[NN]<br>day:TEXT[NN]<br>code:TEXT[NN]<br>layer:TEXT[NN]<br>count:INTEGER[NN]<br>last_at:TEXT |
| `soul_goal_deps` | 目标依赖边 | goal_id:TEXT[NN]<br>depends_on_goal_id:TEXT[NN]<br>kind:TEXT[NN] |
| `soul_goal_events` | 目标状态变更流水 | goal_id:TEXT[NN]<br>event_id:TEXT[NN]<br>change:TEXT[NN]<br>from_status:TEXT<br>to_status:TEXT<br>note:TEXT[NN]<br>at:TEXT[NN] |
| `soul_goals` | 目标（kind/status/progress/依赖/效期） | goal_id:TEXT[PK]<br>team_id:TEXT[NN]<br>user_id:TEXT[NN]<br>agent_id:TEXT[NN]<br>owner:TEXT[NN]<br>kind:TEXT[NN]<br>title:TEXT[NN]<br>why:TEXT[NN]<br>status:TEXT[NN]<br>priority:REAL[NN]<br>progress:REAL[NN]<br>due_at:TEXT<br>parent_goal_id:TEXT<br>source_event_id:TEXT<br>success_criteria:TEXT[NN]<br>blocked_reason:TEXT[NN]<br>abandon_reason:TEXT[NN]<br>valid_from:TEXT[NN]<br>valid_to:TEXT<br>confidence:REAL[NN]<br>created_at:TEXT[NN]<br>updated_at:TEXT[NN] |
| `soul_ledger` | 人格变更账本（append-only，前后哈希+门闸） | entry_id:TEXT[PK]<br>team_id:TEXT[NN]<br>user_id:TEXT[NN]<br>agent_id:TEXT[NN]<br>at:TEXT[NN]<br>trigger:TEXT[NN]<br>layer:TEXT<br>item_id:TEXT<br>action:TEXT[NN]<br>before_hash:TEXT<br>after_hash:TEXT<br>gates_json:TEXT<br>reason:TEXT[NN]<br>evidence_json:TEXT<br>prompt_version:TEXT<br>model:TEXT<br>before_json:TEXT<br>protocol_version:TEXT |
| `soul_mood_events` | 心境变化流水（delta 三维） | id:TEXT[PK]<br>team_id:TEXT[NN]<br>user_id:TEXT[NN]<br>agent_id:TEXT[NN]<br>at:TEXT[NN]<br>kind:TEXT[NN]<br>label:TEXT<br>delta_valence:REAL[NN]<br>delta_arousal:REAL[NN]<br>delta_intensity:REAL[NN]<br>cause_event_ids_json:TEXT[NN]<br>note:TEXT[NN] |
| `soul_mood_state` | 心境状态（标签 + 半衰期 + 成因事件） | team_id:TEXT[NN]<br>user_id:TEXT[NN]<br>agent_id:TEXT[NN]<br>label:TEXT[NN]<br>valence:REAL[NN]<br>arousal:REAL[NN]<br>intensity:REAL[NN]<br>half_life_hours:REAL[NN]<br>cause_event_ids_json:TEXT[NN]<br>updated_at:TEXT[NN] |
| `soul_narrative` | 叙事章节（时段 + 转折点 + 教训 + 版本/hash 链） | chapter_id:TEXT[PK]<br>team_id:TEXT[NN]<br>user_id:TEXT[NN]<br>agent_id:TEXT[NN]<br>period_start:TEXT[NN]<br>period_end:TEXT[NN]<br>title:TEXT[NN]<br>summary:TEXT[NN]<br>turning_points_json:TEXT[NN]<br>lessons_json:TEXT[NN]<br>version:INTEGER[NN]<br>hash:TEXT[NN]<br>supersedes_id:TEXT<br>status:TEXT[NN]<br>created_at:TEXT[NN]<br>salience:REAL[NN]<br>access_count:INTEGER[NN]<br>last_accessed_at:TEXT<br>updated_at:TEXT |
| `soul_narrative_evidence` | 叙事章节证据边 | chapter_id:TEXT[NN]<br>event_id:TEXT[NN]<br>role:TEXT[NN] |
| `soul_person` | 人物主档（platform/platform_id/别名/合并） | person_key:TEXT[PK]<br>team_id:TEXT<br>user_id:TEXT<br>agent_id:TEXT<br>platform:TEXT[NN]<br>platform_id:TEXT<br>display_name:TEXT[NN]<br>aliases_json:TEXT[NN]<br>merged_into:TEXT<br>created_at:TEXT[NN]<br>updated_at:TEXT[NN]<br>profile_at:TEXT<br>profile_record_id:TEXT |
| `soul_person_relation` | 人物关系三元组（subj/pred/obj + 反向谓词 + 效期） | rel_id:TEXT[PK]<br>team_id:TEXT[NN]<br>user_id:TEXT[NN]<br>agent_id:TEXT[NN]<br>subj_key:TEXT[NN]<br>pred:TEXT[NN]<br>inverse_pred:TEXT<br>obj_key:TEXT<br>obj_name:TEXT<br>direction:TEXT[NN]<br>quote:TEXT[NN]<br>record_id:TEXT[NN]<br>valid_from:TEXT[NN]<br>valid_to:TEXT<br>created_at:TEXT[NN]<br>updated_at:TEXT[NN]<br>evidence_json:TEXT[NN] |
| `soul_person_state` | 人物状态（信任/亲近/尊重/义务 + 边界） | person_key:TEXT[NN]<br>team_id:TEXT[NN]<br>user_id:TEXT[NN]<br>agent_id:TEXT[NN]<br>trust:REAL[NN]<br>affinity:REAL[NN]<br>respect:REAL[NN]<br>obligation:REAL[NN]<br>boundaries_json:TEXT[NN]<br>model_json:TEXT[NN]<br>last_interaction_at:TEXT<br>evidence_event_ids_json:TEXT[NN]<br>confidence:REAL[NN]<br>updated_at:TEXT[NN] |
| `soul_person_state_events` | 人物状态变更流水（字段级 old/new） | id:TEXT[PK]<br>person_key:TEXT[NN]<br>team_id:TEXT[NN]<br>user_id:TEXT[NN]<br>agent_id:TEXT[NN]<br>event_id:TEXT<br>field:TEXT[NN]<br>old_value:REAL<br>new_value:REAL<br>reason:TEXT[NN]<br>at:TEXT[NN] |
| `soul_persona` | 八层人格条目（layer/text/state/weight/证据/漂移） | item_id:TEXT[NN]<br>team_id:TEXT[NN]<br>user_id:TEXT[NN]<br>agent_id:TEXT[NN]<br>layer:TEXT[NN]<br>text:TEXT[NN]<br>state:TEXT[NN]<br>weight:REAL[NN]<br>evidence_json:TEXT<br>days_json:TEXT<br>origins_json:TEXT<br>created_at:TEXT[NN]<br>updated_at:TEXT[NN]<br>last_evidence_at:TEXT[NN]<br>merged_into:TEXT<br>aliases_json:TEXT<br>contradictions:INTEGER[NN]<br>drift_json:TEXT<br>meta_json:TEXT<br>confidence:REAL[NN]<br>epistemic:TEXT[NN]<br>source_event_ids_json:TEXT<br>projection_version:TEXT<br>valid_from:TEXT<br>valid_to:TEXT |
| `soul_promise_events` | 承诺状态流转流水 | id:INTEGER[PK]<br>promise_id:TEXT[NN]<br>team_id:TEXT[NN]<br>user_id:TEXT[NN]<br>agent_id:TEXT[NN]<br>from_status:TEXT<br>to_status:TEXT[NN]<br>at:TEXT[NN]<br>note:TEXT<br>source:TEXT[NN] |
| `soul_promises` | 承诺（内容、状态机、来源、ref） | promise_id:TEXT[PK]<br>team_id:TEXT[NN]<br>user_id:TEXT[NN]<br>agent_id:TEXT[NN]<br>content:TEXT[NN]<br>status:TEXT[NN]<br>source:TEXT[NN]<br>ref_key:TEXT[NN]<br>created_at:TEXT[NN]<br>resolved_at:TEXT<br>updated_at:TEXT[NN]<br>goal_id:TEXT |
| `soul_schema_migrations` | Soul 表结构迁移版本 | version:INTEGER[PK]<br>name:TEXT[NN]<br>applied_at:TEXT[NN]<br>checksum:TEXT[NN] |
| `soul_self_model` | 自我模型陈述（kind/scope/置信/反例） | id:TEXT[PK]<br>team_id:TEXT[NN]<br>user_id:TEXT[NN]<br>agent_id:TEXT[NN]<br>kind:TEXT[NN]<br>scope:TEXT[NN]<br>statement:TEXT[NN]<br>confidence:REAL[NN]<br>evidence_event_ids_json:TEXT[NN]<br>counterexample_event_ids_json:TEXT[NN]<br>status:TEXT[NN]<br>last_confirmed_at:TEXT<br>created_at:TEXT[NN]<br>updated_at:TEXT[NN] |
| `soul_snapshots` | 人格快照（内容哈希 + 版本链 + 整套 slots） | id:INTEGER[PK]<br>team_id:TEXT[NN]<br>user_id:TEXT[NN]<br>agent_id:TEXT[NN]<br>ts:TEXT[NN]<br>content_hash:TEXT[NN]<br>payload_json:TEXT[NN]<br>trigger:TEXT[NN]<br>version:INTEGER[NN]<br>parent_hash:TEXT<br>reason_detail:TEXT[NN]<br>slots_json:TEXT[NN] |
| `soul_state` | 情绪主轴状态（valence/arousal/dominance + 基线 + 当前情绪） | team_id:TEXT[NN]<br>user_id:TEXT[NN]<br>agent_id:TEXT[NN]<br>valence:REAL[NN]<br>arousal:REAL[NN]<br>top_value:TEXT<br>turn_seq:INTEGER<br>updated_at:TEXT[NN]<br>baseline_valence:REAL<br>baseline_arousal:REAL<br>sample_count:INTEGER<br>dominance:REAL<br>baseline_dominance:REAL<br>emotion_object:TEXT<br>emotion_label:TEXT<br>emotion_intensity:REAL<br>emotion_at:TEXT |
| `soul_trait_label` | 特质标签词表（标签→定义/方向/证据计数） | tenant_id:TEXT[NN]<br>label:TEXT[NN]<br>definition:TEXT[NN]<br>gloss:TEXT[NN]<br>anchor:TEXT[NN]<br>direction_json:TEXT[NN]<br>evidence:INTEGER[NN]<br>status:TEXT[NN]<br>first_seen:TEXT[NN]<br>last_seen:TEXT[NN]<br>aliases_json:TEXT[NN]<br>protocol_version:TEXT[NN] |
| `soul_trait_state` | 6 轴特质连续状态（轴值与种子态） | team_id:TEXT[NN]<br>user_id:TEXT[NN]<br>agent_id:TEXT[NN]<br>axis_json:TEXT[NN]<br>seed_state_json:TEXT[NN]<br>updated_at:TEXT[NN] |
| `soul_values` | 价值观条目（陈述/优先级/证据/状态） | value_id:TEXT[PK]<br>team_id:TEXT[NN]<br>user_id:TEXT[NN]<br>agent_id:TEXT[NN]<br>statement:TEXT[NN]<br>priority:REAL[NN]<br>source:TEXT[NN]<br>evidence_event_ids_json:TEXT[NN]<br>status:TEXT[NN]<br>created_at:TEXT[NN]<br>updated_at:TEXT[NN] |
| `soul_working_state` | 会话工作态（当前目标/焦点/未决问题，带过期） | team_id:TEXT[NN]<br>user_id:TEXT[NN]<br>agent_id:TEXT[NN]<br>session_id:TEXT[NN]<br>current_goal_id:TEXT<br>current_focus:TEXT[NN]<br>open_questions_json:TEXT[NN]<br>updated_at:TEXT[NN]<br>expires_at:TEXT |

## MemoryKnowledge · knowledge.db（5 表）

| 表 | 说明 | 列（名称:类型[标记]） |
|---|---|---|
| `knowledge_code_graph` | 知识·代码图谱注册（repo 快照/同步状态/统计） | code_graph_id:TEXT[PK]<br>service_id:TEXT[NN]<br>team_id:TEXT[NN]<br>repo_name:TEXT[NN]<br>repo_url:TEXT[NN]<br>branch:TEXT[NN]<br>commit_hash:TEXT<br>owner_user_id:TEXT<br>user_id:TEXT<br>agent_id:TEXT<br>task_id:TEXT<br>visibility:TEXT[NN]<br>status:TEXT[NN]<br>internal_status:TEXT<br>sync_error:TEXT<br>stats_json:TEXT<br>version:INTEGER[NN]<br>last_sync_at:TEXT<br>created_at:TEXT[NN]<br>updated_at:TEXT[NN]<br>deleted_at:TEXT |
| `knowledge_code_graph_audit` | 知识·代码图谱变更审计 | id:INTEGER[PK]<br>code_graph_id:TEXT[NN]<br>service_id:TEXT<br>version:INTEGER[NN]<br>action:TEXT[NN]<br>user_id:TEXT<br>agent_id:TEXT<br>detail:TEXT<br>created_at:TEXT[NN] |
| `knowledge_wiki` | 知识·Wiki 注册（源/路径过滤/页数/同步） | wiki_id:TEXT[PK]<br>service_id:TEXT[NN]<br>team_id:TEXT[NN]<br>name:TEXT[NN]<br>source_type:TEXT<br>source_url:TEXT<br>branch:TEXT<br>path_include:TEXT<br>path_exclude:TEXT<br>owner_user_id:TEXT<br>user_id:TEXT<br>agent_id:TEXT<br>task_id:TEXT<br>visibility:TEXT[NN]<br>status:TEXT[NN]<br>internal_status:TEXT<br>sync_error:TEXT<br>page_count:INTEGER<br>version:INTEGER[NN]<br>last_sync_at:TEXT<br>enabled:INTEGER[NN]<br>stale:INTEGER[NN]<br>created_at:TEXT[NN]<br>updated_at:TEXT[NN]<br>deleted_at:TEXT |
| `knowledge_wiki_audit` | 知识·Wiki 变更审计 | id:INTEGER[PK]<br>wiki_id:TEXT[NN]<br>service_id:TEXT<br>version:INTEGER[NN]<br>action:TEXT[NN]<br>user_id:TEXT<br>agent_id:TEXT<br>detail:TEXT<br>created_at:TEXT[NN] |
| `llm_binding` | 知识服务 LLM 绑定（mode/key/model/baseUrl） | service_id:TEXT[PK]<br>mode:TEXT[NN]<br>api_key:TEXT<br>model:TEXT<br>base_url:TEXT<br>enabled:INTEGER[NN]<br>updated_at:TEXT[NN] |

## MemoryKnowledge · wiki index.db（3 表）

| 表 | 说明 | 列（名称:类型[标记]） |
|---|---|---|
| `graph_edge` | Wiki 索引·页面链接边 | source_id:TEXT[NN]<br>target_id:TEXT[NN] |
| `page_meta` | Wiki 索引·页面元信息（标题/类型/路径/摘要） | page_id:TEXT[PK]<br>title:TEXT<br>type:TEXT<br>rel_path:TEXT<br>snippet:TEXT |
| `source` | Wiki 索引·源文件登记（sha256/状态/摄取错误） | filename:TEXT[PK]<br>sha256:TEXT[NN]<br>size:INTEGER[NN]<br>status:TEXT[NN]<br>created_at:TEXT[NN]<br>updated_at:TEXT[NN]<br>last_modified_by:TEXT<br>ingested_at:TEXT<br>ingest_error:TEXT |

---

标记说明：PK=主键 / UQ=唯一 / NN=NOT NULL / FK=外键引用。列序与类型取自 DDL 原文；JSON 后缀列均为 JSON 文本（TEXT）。