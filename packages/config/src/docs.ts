import type { z } from 'zod';
import { SettingsSchema } from './schema.js';

export interface SettingDoc {
  /** Dotted path, e.g. "embedding.provider". */
  path: string;
  /** Short type tag, e.g. "string", "number", "boolean", "enum: a|b|c". */
  type: string;
  /** Default value as a serialisable JSON value. */
  default: unknown;
  /** Description pulled from zod `.describe()`. Empty string if none. */
  description: string;
}

/**
 * Walk the settings zod schema and produce a flat list of documented fields.
 * Powers `colony config show` and in-terminal help so settings are
 * self-documenting — one source of truth, no parallel docs to drift.
 */
export function settingsDocs(): SettingDoc[] {
  const out: SettingDoc[] = [];
  walk(SettingsSchema, '', out);
  return out;
}

function walk(schema: z.ZodTypeAny, prefix: string, out: SettingDoc[]): void {
  const unwrapped = unwrap(schema);
  const def = unwrapped._def as { typeName?: string; shape?: () => Record<string, z.ZodTypeAny> };

  if (def.typeName === 'ZodObject' && def.shape) {
    const shape = def.shape();
    for (const [key, child] of Object.entries(shape)) {
      const path = prefix ? `${prefix}.${key}` : key;
      const innerUnwrapped = unwrap(child);
      const innerDef = innerUnwrapped._def as { typeName?: string };
      if (innerDef.typeName === 'ZodObject') {
        walk(child, path, out);
      } else {
        out.push({
          path,
          type: typeLabel(innerUnwrapped),
          default: defaultValue(child),
          description: describeText(child) ?? '',
        });
      }
    }
    return;
  }
}

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let s = schema;
  for (let i = 0; i < 8; i++) {
    const def = s._def as { innerType?: z.ZodTypeAny; schema?: z.ZodTypeAny };
    if (def.innerType) {
      s = def.innerType;
      continue;
    }
    if (def.schema) {
      s = def.schema;
      continue;
    }
    return s;
  }
  return s;
}

function describeText(schema: z.ZodTypeAny): string | undefined {
  // zod stores description on every wrapper level; walk outward-to-inward
  // and return the first one found.
  let s: z.ZodTypeAny | undefined = schema;
  for (let i = 0; i < 8 && s; i++) {
    const d = s.description;
    if (d) return d;
    const def = s._def as { innerType?: z.ZodTypeAny; schema?: z.ZodTypeAny };
    s = def.innerType ?? def.schema;
  }
  return undefined;
}

function defaultValue(schema: z.ZodTypeAny): unknown {
  let s: z.ZodTypeAny | undefined = schema;
  for (let i = 0; i < 8 && s; i++) {
    const def = s._def as {
      defaultValue?: () => unknown;
      innerType?: z.ZodTypeAny;
      schema?: z.ZodTypeAny;
    };
    if (def.defaultValue) return def.defaultValue();
    s = def.innerType ?? def.schema;
  }
  return undefined;
}

function typeLabel(schema: z.ZodTypeAny): string {
  const def = schema._def as { typeName?: string; values?: string[] };
  switch (def.typeName) {
    case 'ZodString':
      return 'string';
    case 'ZodNumber':
      return 'number';
    case 'ZodBoolean':
      return 'boolean';
    case 'ZodArray':
      return 'array';
    case 'ZodRecord':
      return 'record';
    case 'ZodEnum':
      return `enum: ${(def.values ?? []).join('|')}`;
    default:
      return def.typeName?.replace(/^Zod/, '').toLowerCase() ?? 'unknown';
  }
}
