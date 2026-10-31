import { describe, expect, it, vi } from 'vitest';
import type { MemoryClient } from '../src/memory-client.js';
import { createRecallTool, formatHits } from '../src/tools.js';
// The host's own enforced JSON Schema subset (vendored verbatim: fixtures/host-json-schema).
// Using it here is what makes the regression below a real trap rather than a
// hand-written opinion: these are the exact functions the host applies to a
// tool definition before it reaches the model.
import { assertObjectJsonSchema, JsonSchemaError, validateJsonSchemaValue } from './fixtures/host-json-schema/json-schema.js';

function fakeClient(recall: (query: string, topK: number, timeoutMs: number) => Promise<any>): MemoryClient {
  return { recall } as unknown as MemoryClient;
}

const tool = (recall: (query: string, topK: number, timeoutMs: number) => Promise<any> = async () => [], defaultLimit = 8) =>
  createRecallTool({ client: fakeClient(recall), defaultLimit, timeoutMs: 500 });

describe('memory_recall tool', () => {
  it('formats hits one per line', () => {
    expect(formatHits([])).toBe('no memory hits');
    expect(formatHits([{ text: 'a  b', layer: 'L1' }, { text: 'c' }])).toBe('- [L1] a b\n- c');
  });

  it('clamps the requested limit and forwards the query', async () => {
    const recall = vi.fn(async () => [{ text: 'hit' }]);
    const output = await tool(recall).execute({ query: '  deploy steps  ', limit: 500 });
    expect(output).toBe('- hit');
    expect(recall).toHaveBeenCalledWith('deploy steps', 50, 500);
  });

  it('uses the default limit when none is given', async () => {
    const recall = vi.fn(async () => []);
    expect(await tool(recall, 6).execute({ query: 'x' })).toBe('no memory hits');
    expect(recall).toHaveBeenCalledWith('x', 6, 500);
  });

  it('refuses an empty query without calling the core', async () => {
    const recall = vi.fn(async () => []);
    expect(await tool(recall).execute({ query: '   ' })).toBe('memory unavailable: empty query');
    expect(recall).not.toHaveBeenCalled();
  });

  it('degrades to a message when the core throws', async () => {
    const recall = vi.fn(async () => {
      throw new Error('core down');
    });
    expect(await tool(recall).execute({ query: 'x' })).toBe('memory unavailable: recall request failed');
  });

  it('declares a JSON Schema object the host accepts', () => {
    const definition = tool();
    expect(definition.name).toBe('memory_recall');
    // The trap this test locks: `parameters` must be a whole JSON Schema object.
    // tools.register() snapshots it verbatim — nothing compiles the DSL field map
    // any more (defineTool lives in @deepseek-ai/dsh-tools, unresolvable from an
    // installed profile), so a field map would reach the model as a schema with no
    // root type and a non-array `required`.
    expect(() => assertObjectJsonSchema(definition.parameters)).not.toThrow();
    expect(definition.parameters).toMatchObject({
      type: 'object',
      required: ['query'],
      additionalProperties: false,
      properties: { query: { type: 'string' }, limit: { type: 'number' } },
    });
    expect(validateJsonSchemaValue(definition.parameters, { query: 'x' })).toEqual([]);
    expect(validateJsonSchemaValue(definition.parameters, { query: 'x', limit: 3 })).toEqual([]);
    // `limit` stays optional: it is simply absent from `required`, never declared
    // as `required: false` — the host rejects that outright ("…required must be
    // true when present") and the whole tool disappears.
    expect(Object.hasOwn(definition.parameters.properties.limit as object, 'required')).toBe(false);
  });

  it('rejects a call with no query, as the model-side schema promises', () => {
    const definition = tool();
    expect(validateJsonSchemaValue(definition.parameters, {}).join(' ')).toContain('query');
    expect(validateJsonSchemaValue(definition.parameters, { limit: 1 }).join(' ')).toContain('query');
  });

  it('would have failed the host subset as an uncompiled field map (regression)', () => {
    // The exact shape the old code registered. Kept as a test so the failure mode
    // stays executable: if someone reintroduces a DSL field map, this passes again
    // only by also breaking the assertion above.
    const fieldMap = { query: { type: 'string', required: true }, limit: { type: 'number' } };
    // The host refuses it as a *schema*...
    expect(() => assertObjectJsonSchema(fieldMap)).toThrow(JsonSchemaError);
    // ...and the failure was silent because a schema-less root constrains nothing:
    // every call validates, including one without `query`. That is exactly how the
    // old definition reached the model with no usable parameter contract.
    expect(validateJsonSchemaValue(fieldMap, {})).toEqual([]);
    expect(Object.hasOwn(fieldMap, 'type')).toBe(false);
  });

  it('renders its output as one text block', () => {
    const definition = tool();
    expect(definition.output.schema).toEqual({ type: 'string' });
    expect(definition.output.render({}, 'text')).toEqual([{ type: 'text', text: 'text' }]);
  });
});
