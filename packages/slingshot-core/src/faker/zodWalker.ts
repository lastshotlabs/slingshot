/**
 * Walks a Zod 4 schema tree and produces a valid fake value using @faker-js/faker.
 *
 * This is the universal primitive behind `generateFromSchema` — it reads Zod's
 * internal `_zod.def` structure to understand types, formats, constraints, and
 * modifiers, then delegates to faker for realistic output.
 *
 * @module
 */
import { faker as defaultFaker, type Faker } from '@faker-js/faker';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Any Zod 4 schema — we read internals via `_zod`. */
interface ZodSchema {
  _zod: {
    def: ZodDef;
    bag?: Record<string, unknown>;
    innerType?: ZodSchema;
  };
}

interface ZodDef {
  type: string;
  // Object
  shape?: Record<string, ZodSchema>;
  // Array
  element?: ZodSchema;
  // Enum
  entries?: Record<string, string | number>;
  // Literal
  values?: unknown[];
  // Union / discriminated union
  options?: ZodSchema[];
  // Nullable, optional, default, readonly, catch, nonoptional, prefault, pipe, success
  innerType?: ZodSchema;
  // Default
  defaultValue?: unknown;
  // Record
  keyType?: ZodSchema;
  valueType?: ZodSchema;
  // Tuple
  items?: ZodSchema[];
  rest?: ZodSchema | null;
  // Intersection
  left?: ZodSchema;
  right?: ZodSchema;
  // Pipe
  in?: ZodSchema;
  out?: ZodSchema;
  // Lazy
  getter?: () => ZodSchema;
  // String format (dedicated format types like ZodUUID, ZodEmail etc.)
  format?: string;
  // Checks
  checks?: ZodCheck[];
  // Coerce
  coerce?: boolean;
}

interface ZodCheck {
  _zod: {
    def: {
      check: string;
      // less_than / greater_than
      value?: number | bigint | Date;
      inclusive?: boolean;
      // min_length / max_length / length_equals
      minimum?: number;
      maximum?: number;
      length?: number;
      // min_size / max_size / size_equals
      // (same fields as above, reused)
      // string_format
      format?: string;
      // regex
      pattern?: RegExp;
      // number_format
    };
  };
}

export interface WalkOptions {
  /** Faker instance — defaults to the global singleton. */
  faker?: Faker;
  /** Override specific field paths. Keys use dot-notation: `"address.city"`. */
  overrides?: Record<string, unknown>;
  /** Maximum depth for recursive schemas (z.lazy). Defaults to 2. */
  maxDepth?: number;
  /** Probability (0–1) that an optional field is present. Defaults to 0.7. */
  optionalRate?: number;
  /** Current path (internal — used for override matching). */
  _path?: string;
  /** Current recursion depth (internal). */
  _depth?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractStringConstraints(def: ZodDef): {
  min?: number;
  max?: number;
  format?: string;
  patterns?: RegExp[];
} {
  const result: { min?: number; max?: number; format?: string; patterns?: RegExp[] } = {};

  // Format can come from the def itself (dedicated format types like ZodUUID)
  if (def.format) {
    result.format = def.format;
  }

  if (!def.checks) return result;
  for (const check of def.checks) {
    const cd = check._zod.def;
    switch (cd.check) {
      case 'min_length':
        result.min = cd.minimum;
        break;
      case 'max_length':
        result.max = cd.maximum;
        break;
      case 'length_equals':
        result.min = cd.length;
        result.max = cd.length;
        break;
      case 'string_format':
        result.format = cd.format;
        break;
      case 'regex':
        if (cd.pattern) {
          result.patterns ??= [];
          result.patterns.push(cd.pattern);
        }
        break;
    }
  }
  return result;
}

function extractNumberConstraints(def: ZodDef): {
  min?: number;
  max?: number;
  isInt: boolean;
} {
  const result: { min?: number; max?: number; isInt: boolean } = { isInt: false };
  if (!def.checks) return result;
  for (const check of def.checks) {
    const cd = check._zod.def;
    switch (cd.check) {
      case 'greater_than':
        result.min = cd.inclusive ? (cd.value as number) : (cd.value as number) + 1;
        break;
      case 'less_than':
        result.max = cd.inclusive ? (cd.value as number) : (cd.value as number) - 1;
        break;
      case 'number_format':
        if ((cd as Record<string, unknown>).format === 'safeint') result.isInt = true;
        break;
    }
  }
  return result;
}

function extractArrayConstraints(def: ZodDef): {
  min?: number;
  max?: number;
} {
  const result: { min?: number; max?: number } = {};
  if (!def.checks) return result;
  for (const check of def.checks) {
    const cd = check._zod.def;
    switch (cd.check) {
      case 'min_size':
        result.min = cd.minimum;
        break;
      case 'max_size':
        result.max = cd.maximum;
        break;
      case 'size_equals':
        result.min = (cd as Record<string, unknown>).size as number;
        result.max = result.min;
        break;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// String format → faker mapping
// ---------------------------------------------------------------------------

function fakeStringForFormat(format: string, f: Faker): string {
  switch (format) {
    case 'email':
      return f.internet.email();
    case 'uuid':
    case 'guid':
      return f.string.uuid();
    case 'url':
      return f.internet.url();
    case 'ipv4':
      return f.internet.ipv4();
    case 'ipv6':
      return f.internet.ipv6();
    case 'cidrv4':
      return `${f.internet.ipv4()}/${f.number.int({ min: 0, max: 32 })}`;
    case 'cidrv6':
      return `${f.internet.ipv6()}/${f.number.int({ min: 0, max: 128 })}`;
    case 'datetime':
      return f.date.recent().toISOString();
    case 'date':
      return f.date.recent().toISOString().split('T')[0];
    case 'time':
      return f.date.recent().toISOString().split('T')[1].replace('Z', '');
    case 'duration':
      return `P${f.number.int({ min: 1, max: 30 })}D`;
    case 'cuid':
      return f.string.alphanumeric(25);
    case 'cuid2':
      return f.string.alphanumeric(24);
    case 'ulid':
      return f.string.alphanumeric(26).toUpperCase();
    case 'nanoid':
      return f.string.alphanumeric(21);
    case 'xid':
      return f.string.alphanumeric(20);
    case 'ksuid':
      return f.string.alphanumeric(27);
    case 'base64':
      return Buffer.from(f.lorem.words(3)).toString('base64');
    case 'base64url':
      return Buffer.from(f.lorem.words(3)).toString('base64url');
    case 'e164':
      return `+1${f.string.numeric(10)}`;
    case 'jwt':
      // Three dot-separated base64url segments
      return [
        Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
        Buffer.from(JSON.stringify({ sub: f.string.uuid(), iat: Math.floor(Date.now() / 1000) })).toString('base64url'),
        f.string.alphanumeric(43),
      ].join('.');
    case 'emoji':
      return f.internet.emoji();
    case 'lowercase':
      return f.lorem.word().toLowerCase();
    case 'uppercase':
      return f.lorem.word().toUpperCase();
    case 'mac':
      return f.internet.mac();
    default:
      return f.lorem.word();
  }
}

// ---------------------------------------------------------------------------
// Core walker
// ---------------------------------------------------------------------------

/**
 * Walk a single Zod schema node and produce a fake value.
 *
 * @internal Prefer `generateFromSchema` for public use.
 */
export function walkSchema(schema: ZodSchema, opts: WalkOptions = {}): unknown {
  const f = opts.faker ?? defaultFaker;
  const path = opts._path ?? '';
  const depth = opts._depth ?? 0;
  const maxDepth = opts.maxDepth ?? 2;
  const optionalRate = opts.optionalRate ?? 0.7;

  // Check overrides first
  if (opts.overrides && path && path in opts.overrides) {
    return opts.overrides[path];
  }

  const def = schema._zod.def;

  switch (def.type) {
    // ----- Primitives -----

    case 'string': {
      const c = extractStringConstraints(def);
      // Format takes priority
      if (c.format) return fakeStringForFormat(c.format, f);
      // Length constraints
      const minLen = c.min ?? 1;
      const maxLen = c.max ?? Math.max(minLen, 50);
      const text = f.lorem.words(3);
      if (text.length < minLen) return text + f.string.alphanumeric(minLen - text.length);
      if (text.length > maxLen) return text.slice(0, maxLen);
      return text;
    }

    case 'number': {
      const c = extractNumberConstraints(def);
      const min = c.min ?? 0;
      const max = c.max ?? 10000;
      if (c.isInt) return f.number.int({ min, max });
      return f.number.float({ min, max, multipleOf: 0.01 });
    }

    case 'int': {
      const c = extractNumberConstraints(def);
      const min = c.min ?? 0;
      const max = c.max ?? 10000;
      return f.number.int({ min, max });
    }

    case 'boolean':
      return f.datatype.boolean();

    case 'bigint':
      return BigInt(f.number.int({ min: 0, max: Number.MAX_SAFE_INTEGER }));

    case 'date': {
      return f.date.recent();
    }

    case 'null':
      return null;

    case 'undefined':
    case 'void':
      return undefined;

    case 'nan':
      return NaN;

    case 'any':
    case 'unknown':
      return f.lorem.word();

    case 'never':
      throw new Error('Cannot generate a value for z.never()');

    case 'symbol':
      return Symbol(f.lorem.word());

    // ----- Composites -----

    case 'object': {
      const shape = def.shape;
      if (!shape) return {};
      const result: Record<string, unknown> = {};
      for (const [key, fieldSchema] of Object.entries(shape)) {
        const fieldPath = path ? `${path}.${key}` : key;
        // Check if the field is optional (via its optout marker)
        const isOptional = fieldSchema._zod.def.type === 'optional'
          || (fieldSchema._zod as Record<string, unknown>).optout === 'optional';

        if (isOptional && !(opts.overrides && fieldPath in opts.overrides)) {
          if (f.number.float({ min: 0, max: 1 }) > optionalRate) continue;
        }

        result[key] = walkSchema(fieldSchema, {
          ...opts,
          _path: fieldPath,
          _depth: depth,
        });
      }
      return result;
    }

    case 'array': {
      if (!def.element) return [];
      const ac = extractArrayConstraints(def);
      const min = ac.min ?? 1;
      const max = ac.max ?? Math.max(min, 3);
      const count = f.number.int({ min, max });
      return Array.from({ length: count }, (_, i) =>
        walkSchema(def.element!, {
          ...opts,
          _path: path ? `${path}.${i}` : `${i}`,
          _depth: depth,
        }),
      );
    }

    case 'tuple': {
      const items = def.items ?? [];
      const result: unknown[] = items.map((item: ZodSchema, i: number) =>
        walkSchema(item, {
          ...opts,
          _path: path ? `${path}.${i}` : `${i}`,
          _depth: depth,
        }),
      );
      // If there's a rest type, add 0-2 extra items
      if (def.rest) {
        const extra = f.number.int({ min: 0, max: 2 });
        for (let i = 0; i < extra; i++) {
          result.push(
            walkSchema(def.rest, {
              ...opts,
              _path: path ? `${path}.${items.length + i}` : `${items.length + i}`,
              _depth: depth,
            }),
          );
        }
      }
      return result;
    }

    case 'record': {
      const valueSchema = def.valueType;
      if (!valueSchema) return {};
      const count = f.number.int({ min: 1, max: 3 });
      const result: Record<string, unknown> = {};
      for (let i = 0; i < count; i++) {
        const key = f.lorem.word();
        result[key] = walkSchema(valueSchema, {
          ...opts,
          _path: path ? `${path}.${key}` : key,
          _depth: depth,
        });
      }
      return result;
    }

    case 'map': {
      const keySchema = def.keyType ?? def.valueType;
      const valueSchema = def.valueType;
      if (!keySchema || !valueSchema) return new Map();
      const count = f.number.int({ min: 1, max: 3 });
      const map = new Map();
      for (let i = 0; i < count; i++) {
        map.set(
          walkSchema(keySchema, { ...opts, _depth: depth }),
          walkSchema(valueSchema, { ...opts, _depth: depth }),
        );
      }
      return map;
    }

    case 'set': {
      const valueSchema = def.valueType;
      if (!valueSchema) return new Set();
      const count = f.number.int({ min: 1, max: 3 });
      const set = new Set();
      for (let i = 0; i < count; i++) {
        set.add(walkSchema(valueSchema, { ...opts, _depth: depth }));
      }
      return set;
    }

    // ----- Enums & Literals -----

    case 'enum': {
      const entries = def.entries;
      if (!entries) return f.lorem.word();
      const values = Object.values(entries);
      return f.helpers.arrayElement(values);
    }

    case 'literal': {
      const vals = def.values;
      if (!vals || vals.length === 0) return undefined;
      return f.helpers.arrayElement(vals as unknown[]);
    }

    // ----- Unions -----

    case 'union': {
      const options = def.options;
      if (!options || options.length === 0) return undefined;
      const chosen = f.helpers.arrayElement(options);
      return walkSchema(chosen, { ...opts, _depth: depth });
    }

    // ----- Wrappers -----

    case 'optional': {
      const inner = def.innerType;
      if (!inner) return undefined;
      // Optional fields: sometimes return undefined
      if (!(opts.overrides && path && path in opts.overrides)) {
        if (f.number.float({ min: 0, max: 1 }) > optionalRate) return undefined;
      }
      return walkSchema(inner, { ...opts, _depth: depth });
    }

    case 'nullable': {
      const inner = def.innerType;
      if (!inner) return null;
      // 10% chance of null
      if (f.number.float({ min: 0, max: 1 }) < 0.1) return null;
      return walkSchema(inner, { ...opts, _depth: depth });
    }

    case 'default': {
      const inner = def.innerType;
      if (!inner) {
        const dv = def.defaultValue;
        return typeof dv === 'function' ? (dv as () => unknown)() : dv;
      }
      return walkSchema(inner, { ...opts, _depth: depth });
    }

    case 'prefault': {
      const inner = def.innerType;
      if (!inner) {
        const dv = def.defaultValue;
        return typeof dv === 'function' ? (dv as () => unknown)() : dv;
      }
      return walkSchema(inner, { ...opts, _depth: depth });
    }

    case 'catch': {
      const inner = def.innerType;
      if (!inner) return undefined;
      return walkSchema(inner, { ...opts, _depth: depth });
    }

    case 'readonly':
    case 'nonoptional':
    case 'success': {
      const inner = def.innerType;
      if (!inner) return undefined;
      return walkSchema(inner, { ...opts, _depth: depth });
    }

    // ----- Pipe / Transform -----

    case 'pipe': {
      // Walk the input side of the pipe — that's what callers provide
      const inSchema = def.in;
      if (inSchema) return walkSchema(inSchema, { ...opts, _depth: depth });
      const inner = def.innerType;
      if (inner) return walkSchema(inner, { ...opts, _depth: depth });
      return undefined;
    }

    case 'transform': {
      // Transforms don't have an inner type we can walk — produce a string
      return f.lorem.word();
    }

    // ----- Intersection -----

    case 'intersection': {
      const left = def.left;
      const right = def.right;
      if (!left || !right) return {};
      const leftVal = walkSchema(left, { ...opts, _depth: depth });
      const rightVal = walkSchema(right, { ...opts, _depth: depth });
      if (typeof leftVal === 'object' && typeof rightVal === 'object' && leftVal && rightVal) {
        return { ...leftVal as Record<string, unknown>, ...rightVal as Record<string, unknown> };
      }
      return leftVal;
    }

    // ----- Lazy (recursive schemas) -----

    case 'lazy': {
      if (depth >= maxDepth) {
        // Return a minimal value to break recursion
        return null;
      }
      const getter = def.getter;
      if (!getter) return null;
      const resolved = getter();
      return walkSchema(resolved, { ...opts, _depth: depth + 1 });
    }

    // ----- Fallback -----

    case 'custom':
      return f.lorem.word();

    case 'template_literal':
      return f.lorem.word();

    case 'promise': {
      const inner = def.innerType;
      if (!inner) return Promise.resolve(undefined);
      return Promise.resolve(walkSchema(inner, { ...opts, _depth: depth }));
    }

    case 'function':
      return () => {};

    case 'file':
      return new Blob([f.lorem.paragraph()], { type: 'text/plain' });

    default:
      return f.lorem.word();
  }
}
