/** Hand-written types for the vendored validator (see json-schema.js). */
export class JsonSchemaError extends Error {
  readonly violations: string[];
  constructor(violations: string[]);
}
export function isJsonSchemaRecord(value: unknown): boolean;
export function assertSupportedJsonSchema(schema: unknown): void;
export function assertObjectJsonSchema(schema: unknown): void;
export function validateJsonSchemaValue(schema: unknown, value: unknown, path?: string): string[];
