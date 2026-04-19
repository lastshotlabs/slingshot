/**
 * Walks a Zod 4 schema tree and produces a valid fake value using @faker-js/faker.
 *
 * This is the universal primitive behind `generateFromSchema` — it reads Zod's
 * internal `_zod.def` structure to understand types, formats, constraints, and
 * modifiers, then delegates to faker for realistic output.
 *
 * @module
 */
import { type Faker, faker as defaultFaker } from '@faker-js/faker';

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
  /**
   * When true, the `optional` case handler skips its probability roll.
   * Set by the object handler after it already decided to include the field,
   * preventing double-roll for any wrapper ordering (e.g. `.optional().nullable()`).
   * @internal
   */
  _optionalDecided?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractStringConstraints(def: ZodDef): {
  min?: number;
  max?: number;
  format?: string;
  patterns?: RegExp[];
  prefix?: string;
  suffix?: string;
  includes?: string;
} {
  const result: {
    min?: number;
    max?: number;
    format?: string;
    patterns?: RegExp[];
    prefix?: string;
    suffix?: string;
    includes?: string;
  } = {};

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
      case 'string_format': {
        const fmt = cd.format;
        result.format = fmt;
        // Extract constraint values for starts_with / ends_with / includes
        if (fmt === 'starts_with') result.prefix = (cd as Record<string, unknown>).prefix as string;
        if (fmt === 'ends_with') result.suffix = (cd as Record<string, unknown>).suffix as string;
        if (fmt === 'includes')
          result.includes = (cd as Record<string, unknown>).includes as string;
        break;
      }
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
  minExclusive: boolean;
  maxExclusive: boolean;
  isInt: boolean;
  multipleOf?: number;
} {
  const result: {
    min?: number;
    max?: number;
    minExclusive: boolean;
    maxExclusive: boolean;
    isInt: boolean;
    multipleOf?: number;
  } = {
    isInt: false,
    minExclusive: false,
    maxExclusive: false,
  };

  // z.int() sets def.format directly (no checks), while z.number().int()
  // uses a number_format check. Handle both.
  if (def.format === 'safeint' || def.format === 'int32' || def.format === 'uint32') {
    result.isInt = true;
  }

  if (!def.checks) return result;
  for (const check of def.checks) {
    const cd = check._zod.def;
    switch (cd.check) {
      case 'greater_than': {
        result.min = cd.value as number;
        result.minExclusive = !cd.inclusive;
        break;
      }
      case 'less_than': {
        result.max = cd.value as number;
        result.maxExclusive = !cd.inclusive;
        break;
      }
      case 'number_format': {
        const fmt = (cd as Record<string, unknown>).format as string | undefined;
        if (fmt === 'safeint' || fmt === 'int32' || fmt === 'uint32') {
          result.isInt = true;
        }
        break;
      }
      case 'multiple_of': {
        result.multipleOf = cd.value as number;
        break;
      }
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
    }
  }
  return result;
}

function extractSetConstraints(def: ZodDef): {
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
        result.max = (cd as Record<string, unknown>).size as number;
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
      return 'c' + f.string.alphanumeric(24);
    case 'cuid2':
      return f.string.alphanumeric(24).toLowerCase();
    case 'ulid':
      return f.string.fromCharacters('0123456789ABCDEFGHJKMNPQRSTVWXYZ', 26);
    case 'nanoid':
      return f.string.alphanumeric(21);
    case 'xid':
      return f.string.fromCharacters('0123456789abcdefghijklmnopqrstuv', 20);
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
        Buffer.from(
          JSON.stringify({ sub: f.string.uuid(), iat: Math.floor(Date.now() / 1000) }),
        ).toString('base64url'),
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
      const hasConstraintFormat =
        c.prefix !== undefined || c.suffix !== undefined || c.includes !== undefined;

      // String constraint formats (startsWith, endsWith, includes) need
      // special handling — the generated string must satisfy ALL constraints
      // while also respecting any min/max length checks.
      if (hasConstraintFormat) {
        const prefix = c.prefix ?? '';
        const suffix = c.suffix ?? '';
        const middle = c.includes ?? '';
        // Build: prefix + body_before + middle + body_after + suffix
        let bodyBefore = middle ? f.lorem.word() : '';
        let bodyAfter = f.lorem.word();
        const fixedLen = prefix.length + middle.length + suffix.length;
        const minLen = c.min ?? 1;
        const maxLen = c.max ?? Math.max(minLen, 50);
        const total = fixedLen + bodyBefore.length + bodyAfter.length;
        if (total < minLen) bodyAfter += f.string.alphanumeric(minLen - total);
        const currentLen = fixedLen + bodyBefore.length + bodyAfter.length;
        if (currentLen > maxLen) {
          const available = Math.max(0, maxLen - fixedLen);
          const halfAvail = Math.floor(available / 2);
          bodyBefore = bodyBefore.slice(0, halfAvail);
          bodyAfter = bodyAfter.slice(0, available - halfAvail);
        }
        return prefix + bodyBefore + middle + bodyAfter + suffix;
      }
      // Format takes priority (email, uuid, url, etc.)
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
      // Derive sane defaults: if only one bound is set, pick the other
      // relative to it so the range is always valid.
      // Account for exclusivity when deciding defaults (e.g. lt(0) exclusive
      // means the effective upper bound is negative, so default min must also be negative).
      const effectiveMax = c.max !== undefined && c.maxExclusive ? c.max - 1 : c.max;
      const effectiveMin = c.min !== undefined && c.minExclusive ? c.min + 1 : c.min;
      const rawMin = c.min ?? (effectiveMax !== undefined && effectiveMax < 0 ? c.max! - 10000 : 0);
      const rawMax =
        c.max ?? (effectiveMin !== undefined && effectiveMin > 10000 ? c.min! + 10000 : 10000);
      // For exclusive bounds on integers, nudge by 1. For floats, we defer
      // the nudge to the float generator which handles precision naturally.
      const min = c.minExclusive && c.isInt ? rawMin + 1 : rawMin;
      const max = c.maxExclusive && c.isInt ? rawMax - 1 : rawMax;
      // multipleOf must be checked before bare isInt — the step-based generator
      // already produces integers when the step itself is an integer, and checking
      // isInt first would shadow the multipleOf constraint entirely.
      if (c.multipleOf) {
        let stepMin = Math.ceil(min / c.multipleOf);
        let stepMax = Math.floor(max / c.multipleOf);
        // For exclusive bounds, exclude the exact boundary multiples
        if (c.minExclusive && stepMin * c.multipleOf === rawMin) stepMin++;
        if (c.maxExclusive && stepMax * c.multipleOf === rawMax) stepMax--;
        // When no valid multiple exists in the range, return the nearest one
        if (stepMin > stepMax) {
          const nearest = Math.round((min + max) / 2 / c.multipleOf) * c.multipleOf;
          const decStr = c.multipleOf.toString().split('.')[1];
          const decimals = decStr ? decStr.length : 0;
          return decimals > 0 ? Number(nearest.toFixed(decimals)) : nearest;
        }
        const raw = f.number.int({ min: stepMin, max: stepMax }) * c.multipleOf;
        // Round to the step's decimal precision to avoid IEEE 754 drift
        // (e.g. 4359 * 0.1 = 435.90000000000001 instead of 435.9)
        const decStr = c.multipleOf.toString().split('.')[1];
        const decimals = decStr ? decStr.length : 0;
        return decimals > 0 ? Number(raw.toFixed(decimals)) : raw;
      }
      if (c.isInt) {
        const intMin = Math.ceil(min);
        const intMax = Math.floor(max);
        // Graceful fallback when no integer exists in the range
        if (intMin > intMax) return intMin;
        return f.number.int({ min: intMin, max: intMax });
      }
      // For floats with exclusive bounds, nudge inward slightly to avoid
      // generating the exact boundary value.
      let floatMin = c.minExclusive ? min + Math.max(Math.abs(min) * 1e-10, 1e-15) : min;
      let floatMax = c.maxExclusive ? max - Math.max(Math.abs(max) * 1e-10, 1e-15) : max;
      // Graceful fallback when bounds create an inverted range
      if (floatMin > floatMax) return (rawMin + rawMax) / 2;
      // Use a precision step appropriate for the range size
      const range = floatMax - floatMin;
      const step = range < 0.1 ? range / 10 : range < 1 ? 0.001 : 0.01;
      return f.number.float({ min: floatMin, max: floatMax, multipleOf: step });
    }

    case 'int': {
      const c = extractNumberConstraints(def);
      const effectiveMaxI = c.max !== undefined && c.maxExclusive ? c.max - 1 : c.max;
      const effectiveMinI = c.min !== undefined && c.minExclusive ? c.min + 1 : c.min;
      const rawMin =
        c.min ?? (effectiveMaxI !== undefined && effectiveMaxI < 0 ? c.max! - 10000 : 0);
      const rawMax =
        c.max ?? (effectiveMinI !== undefined && effectiveMinI > 10000 ? c.min! + 10000 : 10000);
      const min = c.minExclusive ? rawMin + 1 : rawMin;
      const max = c.maxExclusive ? rawMax - 1 : rawMax;
      const intMin = Math.ceil(min);
      const intMax = Math.floor(max);
      if (intMin > intMax) return intMin;
      return f.number.int({ min: intMin, max: intMax });
    }

    case 'boolean':
      return f.datatype.boolean();

    case 'bigint': {
      let bigMin = 0n;
      let bigMax = BigInt(Number.MAX_SAFE_INTEGER);
      if (def.checks) {
        for (const check of def.checks) {
          const cd = check._zod.def;
          if (cd.check === 'greater_than' && typeof cd.value === 'bigint') {
            bigMin = cd.inclusive ? cd.value : cd.value + 1n;
          } else if (cd.check === 'less_than' && typeof cd.value === 'bigint') {
            bigMax = cd.inclusive ? cd.value : cd.value - 1n;
          }
        }
      }
      // Convert to number range for faker (safe for ranges within Number.MAX_SAFE_INTEGER)
      const numMin = Number(
        bigMin < BigInt(-Number.MAX_SAFE_INTEGER) ? BigInt(-Number.MAX_SAFE_INTEGER) : bigMin,
      );
      const numMax = Number(
        bigMax > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : bigMax,
      );
      return BigInt(f.number.int({ min: numMin, max: numMax }));
    }

    case 'date': {
      let minDate: Date | undefined;
      let maxDate: Date | undefined;
      if (def.checks) {
        for (const check of def.checks) {
          const cd = check._zod.def;
          if (cd.check === 'greater_than' && cd.value instanceof Date) {
            minDate = cd.value;
          } else if (cd.check === 'less_than' && cd.value instanceof Date) {
            maxDate = cd.value;
          }
        }
      }
      if (minDate || maxDate) {
        const from = minDate ?? new Date(0);
        const to = maxDate ?? new Date();
        return f.date.between({ from, to });
      }
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
        const hasOverride = opts.overrides && fieldPath in opts.overrides;
        // Also check for nested overrides (e.g. "address.city" when field is "address")
        const hasNestedOverride =
          !hasOverride &&
          opts.overrides &&
          Object.keys(opts.overrides).some(k => k.startsWith(fieldPath + '.'));

        // Detect optional wrapper — the field's def.type is 'optional' or
        // Zod 4 marks it with the optout sentinel on the internals.
        const isWrappedOptional = fieldSchema._zod.def.type === 'optional';
        const isMarkedOptional =
          (fieldSchema._zod as Record<string, unknown>).optout === 'optional';
        const isOptional = isWrappedOptional || isMarkedOptional;

        if (isOptional && !hasOverride && !hasNestedOverride) {
          if (f.number.float({ min: 0, max: 1 }) > optionalRate) continue;
        }

        // If the field is wrapped in z.optional(), unwrap it so the optional
        // handler doesn't roll the dice a second time. We already decided
        // above that the field should be present.
        const schemaToWalk =
          isWrappedOptional && fieldSchema._zod.def.innerType
            ? fieldSchema._zod.def.innerType
            : fieldSchema;

        result[key] = walkSchema(schemaToWalk as ZodSchema, {
          ...opts,
          _path: fieldPath,
          _depth: depth,
          // Signal to downstream optional/nullable handlers that the object
          // handler already decided this field should be present.
          _optionalDecided: isOptional,
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
      const keySchema = def.keyType;
      const result: Record<string, unknown> = {};

      // For enum-keyed records, Zod requires ALL enum values as keys.
      // Filter out reverse-mappings from numeric nativeEnums (same logic as enum handler).
      if (keySchema && keySchema._zod.def.type === 'enum' && keySchema._zod.def.entries) {
        const entries = keySchema._zod.def.entries;
        const hasNumericValues = Object.entries(entries).some(
          ([k, v]) => typeof v === 'number' && !/^\d+$/.test(k),
        );
        const keys = hasNumericValues
          ? (Object.entries(entries)
              .filter(([k]) => !/^\d+$/.test(k))
              .map(([, v]) => v) as (string | number)[])
          : (Object.values(entries) as (string | number)[]);
        for (const key of keys) {
          const keyString = String(key);
          result[keyString] = walkSchema(valueSchema, {
            ...opts,
            _path: path ? `${path}.${keyString}` : keyString,
            _depth: depth,
          });
        }
      } else {
        const count = f.number.int({ min: 1, max: 3 });
        for (let i = 0; i < count; i++) {
          // Walk the key schema if present to produce valid keys,
          // otherwise fall back to a random word.
          const key = keySchema
            ? String(walkSchema(keySchema, { ...opts, _depth: depth }))
            : f.lorem.word();
          result[key] = walkSchema(valueSchema, {
            ...opts,
            _path: path ? `${path}.${key}` : key,
            _depth: depth,
          });
        }
      }
      return result;
    }

    case 'map': {
      const keySchema = def.keyType;
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
      const sc = extractSetConstraints(def);
      const setMin = sc.min ?? 1;
      const setMax = sc.max ?? Math.max(setMin, 3);
      const count = f.number.int({ min: setMin, max: setMax });
      const set = new Set();
      // Generate enough attempts to fill the set (values might collide)
      let attempts = 0;
      while (set.size < count && attempts < count * 3) {
        set.add(walkSchema(valueSchema, { ...opts, _depth: depth }));
        attempts++;
      }
      return set;
    }

    // ----- Enums & Literals -----

    case 'enum': {
      const entries = def.entries;
      if (!entries) return f.lorem.word();
      // Numeric nativeEnums produce reverse-mapped entries like { "0": "Low", Low: 0 }.
      // Filter out the reverse mappings (numeric-string keys whose values are strings)
      // so we only pick valid enum values.
      const hasNumericValues = Object.entries(entries).some(
        ([k, v]) => typeof v === 'number' && !/^\d+$/.test(k),
      );
      const values = hasNumericValues
        ? Object.entries(entries)
            .filter(([k]) => !/^\d+$/.test(k))
            .map(([, v]) => v)
        : Object.values(entries);
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
      // If the object handler already decided to include this field, skip the roll
      if (!opts._optionalDecided) {
        const hasDirectOverride = opts.overrides && path && path in opts.overrides;
        const hasNestedOverride =
          !hasDirectOverride &&
          opts.overrides &&
          path &&
          Object.keys(opts.overrides).some(k => k.startsWith(path + '.'));
        // Also check for unpathed overrides (standalone optional wrapping an object)
        const hasUnpathedNested =
          !hasDirectOverride &&
          !hasNestedOverride &&
          !path &&
          opts.overrides &&
          Object.keys(opts.overrides).length > 0;
        if (!hasDirectOverride && !hasNestedOverride && !hasUnpathedNested) {
          if (f.number.float({ min: 0, max: 1 }) > optionalRate) return undefined;
        }
      }
      return walkSchema(inner, { ...opts, _optionalDecided: false, _depth: depth });
    }

    case 'nullable': {
      const inner = def.innerType;
      if (!inner) return null;
      // Skip null roll when overrides target this path or nested fields
      const hasDirectOverride = opts.overrides && path && path in opts.overrides;
      const hasNestedOverride =
        !hasDirectOverride &&
        opts.overrides &&
        path &&
        Object.keys(opts.overrides).some(k => k.startsWith(path + '.'));
      // Also check for unpathed overrides (standalone nullable wrapping an object)
      const hasUnpathedNested =
        !hasDirectOverride &&
        !hasNestedOverride &&
        !path &&
        opts.overrides &&
        Object.keys(opts.overrides).length > 0;
      if (!hasDirectOverride && !hasNestedOverride && !hasUnpathedNested) {
        // 10% chance of null
        if (f.number.float({ min: 0, max: 1 }) < 0.1) return null;
      }
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

    case 'nonoptional': {
      let inner = def.innerType;
      if (!inner) return undefined;
      // Skip the optional wrapper that nonoptional negates — without this,
      // the optional handler would roll the dice and sometimes return undefined
      // even though the field is required.
      if (inner._zod.def.type === 'optional' && inner._zod.def.innerType) {
        inner = inner._zod.def.innerType;
      }
      return walkSchema(inner, { ...opts, _depth: depth });
    }

    case 'readonly':
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
        return {
          ...(leftVal as Record<string, unknown>),
          ...(rightVal as Record<string, unknown>),
        };
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
