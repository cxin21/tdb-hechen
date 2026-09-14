/**
 * member-llm —— Shared types for the member-customizable LLM provider store.
 *
 * See docs/superpowers/specs/2026-09-04-member-llm-provider-design.md §4
 * ("llm_provider" table): a provider is keyed globally by the composite
 * `(subject_type, subject_id)` — a user-level default or an agent-level
 * override for a single OpenAI-compatible upstream (url + apiKey + default
 * model). Unlike session-scoped storage, member providers are NOT scoped to a
 * request space (the spec table has no spaceId column).
 */

/** Subject kinds that may own a provider. */
export type LlmProviderSubjectType = "user" | "agent";

/** A persisted member-provider entry (mirrors the llm_provider record). */
export interface LlmProvider {
  subject_type: LlmProviderSubjectType;
  subject_id: string;
  /** OpenAI-compatible base upstream URL (e.g. http://host/v1). */
  url: string;
  /** Member's upstream API key (plain text, matching existing key handling). */
  apiKey: string;
  /** Default model name — replaces the client's `body.model` at the seam. */
  model: string;
  /** Audit trail — populated by the write API from the authenticated user (spec §4). */
  created_by: string;
  created_at: string;
  updated_by: string;
  updated_at: string;
}