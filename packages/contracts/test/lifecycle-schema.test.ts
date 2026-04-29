import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import schema from '../schemas/colony-omx-lifecycle-v1.schema.json';

const fixtureDir = join(import.meta.dirname, '../fixtures/colony-omx-lifecycle-v1');

interface ValidationError {
  path: string;
  message: string;
}

type JsonSchema = {
  type?: string;
  enum?: unknown[];
  const?: unknown;
  required?: string[];
  additionalProperties?: boolean;
  minProperties?: number;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  format?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  allOf?: JsonSchema[];
  if?: JsonSchema;
  then?: JsonSchema;
  $ref?: string;
};

function fixtures(): Array<{ name: string; value: Record<string, unknown> }> {
  return readdirSync(fixtureDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => ({
      name,
      value: JSON.parse(readFileSync(join(fixtureDir, name), 'utf8')) as Record<string, unknown>,
    }));
}

function validate(
  value: unknown,
  node: JsonSchema = schema as JsonSchema,
  path = '$',
): ValidationError[] {
  const resolved = resolveRef(node);
  const errors: ValidationError[] = [];

  if (resolved.const !== undefined && value !== resolved.const) {
    errors.push({ path, message: `expected const ${String(resolved.const)}` });
  }
  if (resolved.enum && !resolved.enum.includes(value)) {
    errors.push({ path, message: `expected one of ${resolved.enum.join(', ')}` });
  }
  if (resolved.type && !matchesType(value, resolved.type)) {
    errors.push({ path, message: `expected ${resolved.type}` });
    return errors;
  }

  if (typeof value === 'string') {
    if (resolved.minLength !== undefined && value.length < resolved.minLength) {
      errors.push({ path, message: `minLength ${resolved.minLength}` });
    }
    if (resolved.maxLength !== undefined && value.length > resolved.maxLength) {
      errors.push({ path, message: `maxLength ${resolved.maxLength}` });
    }
    if (resolved.format === 'date-time' && Number.isNaN(Date.parse(value))) {
      errors.push({ path, message: 'invalid date-time' });
    }
  }

  if (typeof value === 'number' && resolved.minimum !== undefined && value < resolved.minimum) {
    errors.push({ path, message: `minimum ${resolved.minimum}` });
  }

  if (Array.isArray(value) && resolved.items) {
    value.forEach((item, index) => {
      errors.push(...validate(item, resolved.items, `${path}[${index}]`));
    });
  }

  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (resolved.minProperties !== undefined && keys.length < resolved.minProperties) {
      errors.push({ path, message: `minProperties ${resolved.minProperties}` });
    }
    for (const required of resolved.required ?? []) {
      if (!(required in value)) errors.push({ path, message: `missing ${required}` });
    }
    const properties = resolved.properties ?? {};
    if (resolved.additionalProperties === false) {
      for (const key of keys) {
        if (!(key in properties)) errors.push({ path: `${path}.${key}`, message: 'unexpected' });
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (key in value) errors.push(...validate(value[key], child, `${path}.${key}`));
    }
  }

  for (const child of resolved.allOf ?? []) {
    errors.push(...validate(value, child, path));
  }

  if (resolved.if && resolved.then && validate(value, resolved.if, path).length === 0) {
    errors.push(...validate(value, resolved.then, path));
  }

  return errors;
}

function resolveRef(node: JsonSchema): JsonSchema {
  if (!node.$ref) return node;
  const prefix = '#/$defs/';
  if (!node.$ref.startsWith(prefix)) throw new Error(`unsupported ref ${node.$ref}`);
  const key = node.$ref.slice(prefix.length);
  const defs = (schema as { $defs: Record<string, JsonSchema> }).$defs;
  return defs[key] ?? {};
}

function matchesType(value: unknown, type: string): boolean {
  if (type === 'object') return isRecord(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'number') return typeof value === 'number';
  if (type === 'boolean') return typeof value === 'boolean';
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

describe('colony-omx-lifecycle-v1 schema', () => {
  it('validates every shared fixture', () => {
    for (const fixture of fixtures()) {
      expect(validate(fixture.value), fixture.name).toEqual([]);
    }
  });

  it('defines the required lifecycle envelope fields', () => {
    expect(schema.required).toEqual([
      'event_id',
      'event_name',
      'session_id',
      'agent',
      'cwd',
      'repo_root',
      'branch',
      'timestamp',
      'source',
    ]);
  });

  it('enumerates supported lifecycle event names', () => {
    expect(schema.properties.event_name.enum).toEqual([
      'session_start',
      'task_bind',
      'pre_tool_use',
      'post_tool_use',
      'claim_result',
      'stop_intent',
      'finish_result',
    ]);
  });

  it('fails every missing required envelope field', () => {
    const [fixture] = fixtures();
    if (!fixture) throw new Error('fixtures missing');

    for (const field of schema.required) {
      const invalid = { ...fixture.value };
      delete invalid[field];
      expect(
        validate(invalid).some((error) => error.message === `missing ${field}`),
        field,
      ).toBe(true);
    }
  });

  it('requires tool fields on tool lifecycle events', () => {
    const [fixture] = fixtures();
    if (!fixture) throw new Error('fixtures missing');
    const invalid = { ...fixture.value };
    delete invalid.tool_name;

    expect(validate(invalid).some((error) => error.message === 'missing tool_name')).toBe(true);
  });

  it('uses parent_event_id to link distinct post_tool_use events to pre_tool_use', () => {
    const editPost = fixtures().find((fixture) => fixture.name === 'codex-edit.post.json');
    expect(editPost?.value).toMatchObject({
      event_id: 'evt_codex_edit_post_001',
      parent_event_id: 'evt_codex_edit_pre_001',
      event_name: 'post_tool_use',
    });
  });

  it('rejects raw content fields in sanitized tool input', () => {
    const [fixture] = fixtures();
    if (!fixture) throw new Error('fixtures missing');
    const invalid = {
      ...fixture.value,
      tool_input: {
        ...(fixture.value.tool_input as Record<string, unknown>),
        new_string: 'raw file content',
      },
    };

    expect(validate(invalid).some((error) => error.path === '$.tool_input.new_string')).toBe(true);
  });

  it('defines status, code, message, next_action, and candidates result shape', () => {
    const result = schema.$defs.result;
    expect(result.required).toEqual(['status', 'code', 'message', 'next_action', 'candidates']);
    expect(result.properties.status.enum).toEqual(['ok', 'warning', 'error']);
  });

  it('represents /dev/null as an explicit pseudo-path case', () => {
    const fixture = fixtures().find(
      (candidate) => candidate.name === 'dev-null-pseudo-path.pre.json',
    );
    const paths = (fixture?.value.tool_input as { paths: unknown[] }).paths;

    expect(paths).toContainEqual({
      path: '/dev/null',
      role: 'source',
      kind: 'pseudo',
      pseudo: 'dev_null',
    });
    expect(
      validate({ path: '/dev/null', role: 'source', kind: 'file' }, schema.$defs.path_ref),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '$.kind',
          message: 'expected const pseudo',
        }),
      ]),
    );
  });

  it('allows extracted_paths on Bash and apply_patch pre_tool_use payloads', () => {
    const bash = fixtures().find((fixture) => fixture.name === 'bash.pre.json');
    const applyPatch = fixtures().find((fixture) => fixture.name === 'apply-patch.pre.json');

    expect((bash?.value.tool_input as { extracted_paths?: string[] }).extracted_paths).toEqual([
      'packages/contracts/src/generated.ts',
    ]);
    expect(
      (applyPatch?.value.tool_input as { extracted_paths?: string[] }).extracted_paths,
    ).toEqual(['packages/contracts/src/index.ts']);
  });
});
