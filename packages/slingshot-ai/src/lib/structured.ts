/**
 * Structured output: zod → JSON Schema → a validated object, on ANY provider.
 *
 * This is the riskiest code in the package, and the difference between "works
 * on Ollama" and "doesn't". Three paths, chosen from the provider's declared
 * capabilities:
 *
 *   native    → the provider enforces the schema. We still re-validate.
 *   json-mode → syntactically valid JSON, unenforced shape. We validate.
 *   prompt    → no guarantee at all. We instruct, extract, validate, and repair.
 *
 * Note what is common to all three: **we always validate**. The provider's own
 * parsed object is advisory. That is why Anthropic returning `parsed_output:
 * null` and a 7B model emitting a fenced code block with a trailing comma
 * converge on exactly one code path.
 */
import { z } from 'zod';
import { AiConfigError } from '../errors';
import type { AiLogger, ProviderCapabilities, StructuredMode } from '../provider/types';

/**
 * JSON Schema keywords that Anthropic's structured output rejects.
 *
 * Zod emits these readily — `z.string().max(240)` becomes `maxLength: 240`,
 * `z.array(x).min(1)` becomes `minItems: 1` — so a perfectly reasonable card
 * schema will 400 on the very first call unless we strip them. We strip rather
 * than refuse, because the constraint is still enforced: `safeParse` runs the
 * REAL zod schema on the result, min/max and all. The model just doesn't get
 * told about the bounds up front.
 */
/**
 * Metadata zod always emits and providers never want. Dropped SILENTLY — the
 * app didn't ask for it, so warning about it (or, under `strict`, throwing) is
 * noise that would make strict mode unusable with every schema on earth.
 */
const METADATA_KEYWORDS = ['$schema'] as const;

const UNSUPPORTED_KEYWORDS = [
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'pattern',
  'format',
] as const;

export interface SanitizeResult {
  readonly schema: Record<string, unknown>;
  /** Keywords we removed, for the warning. */
  readonly stripped: readonly string[];
}

/**
 * Strip keywords a strict structured-output provider rejects, and force
 * `additionalProperties: false` on every object (which those providers require).
 *
 * Recursion (`$ref` pointing at an ancestor) is not supported by strict
 * structured output either; we detect and reject it loudly rather than send
 * something that will 400 with a much worse message.
 */
export function sanitizeJsonSchema(input: unknown): SanitizeResult {
  const stripped = new Set<string>();

  function walk(node: unknown, depth: number): unknown {
    if (depth > 64) {
      throw new AiConfigError(
        'JSON Schema nests deeper than 64 levels — this is almost certainly a recursive schema, ' +
          'which strict structured output does not support. Flatten it or use a non-strict provider.',
      );
    }
    if (Array.isArray(node)) return node.map(item => walk(item, depth + 1));
    if (!node || typeof node !== 'object') return node;

    const source = node as Record<string, unknown>;
    const output: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(source)) {
      if ((METADATA_KEYWORDS as readonly string[]).includes(key)) continue;
      if ((UNSUPPORTED_KEYWORDS as readonly string[]).includes(key)) {
        stripped.add(key);
        continue;
      }
      output[key] = walk(value, depth + 1);
    }

    // Strict providers require this on every object node.
    if (output.type === 'object' && output.additionalProperties === undefined) {
      output.additionalProperties = false;
    }
    return output;
  }

  if (typeof input === 'object' && input !== null && '$ref' in (input as object)) {
    throw new AiConfigError(
      'Top-level $ref in a JSON Schema is not supported by strict structured output.',
    );
  }

  const schema = walk(input, 0) as Record<string, unknown>;
  return { schema, stripped: [...stripped].sort() };
}

/** Convert a zod schema to a sanitized JSON Schema. */
export function toJsonSchema(
  schema: z.ZodType<unknown>,
  options: { logger?: AiLogger; strict: boolean; name: string },
): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, { io: 'output' }) as Record<string, unknown>;
  const { schema: sanitized, stripped } = sanitizeJsonSchema(raw);

  if (stripped.length > 0) {
    const message =
      `schema '${options.name}': stripped JSON Schema keywords that strict structured-output ` +
      `providers reject: ${stripped.join(', ')}. The constraints are still enforced — the result ` +
      `is validated against the real zod schema — but the model is not told about them up front. ` +
      `Restate any that matter (e.g. a length limit) in your prompt.`;
    if (options.strict) throw new AiConfigError(message);
    options.logger?.warn(message, { schema: options.name, stripped });
  }
  return sanitized;
}

/** Pick how to get JSON out of this provider. */
export function chooseStructuredMode(capabilities: ProviderCapabilities): StructuredMode {
  switch (capabilities.structuredOutput) {
    case 'native':
      return 'native';
    case 'json-mode':
      return 'json-mode';
    default:
      return 'prompt';
  }
}

/**
 * Extract a JSON object from text that may be wrapped in prose, fences, or both.
 *
 * A model told "reply with JSON" will nonetheless say "Sure! Here's the JSON:"
 * and wrap it in ```json. This is not a bug in the model; it is the reality of
 * the prompt path, and it is what this function is for.
 */
export function extractJson(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // 1. A fenced block, with or without a language tag.
  const fence = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/.exec(trimmed);
  if (fence?.[1]) {
    const inner = fence[1].trim();
    if (inner) return inner;
  }

  // 2. Bare JSON.
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    return trimmed;
  }

  // 3. Prose with an object/array embedded somewhere — take the outermost
  //    balanced span, so a `}` inside a string doesn't truncate us.
  const start = trimmed.search(/[{[]/);
  if (start === -1) return null;
  const opener = trimmed[start];
  const closer = opener === '{' ? '}' : ']';

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i++) {
    const char = trimmed[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === opener) depth++;
    else if (char === closer) {
      depth--;
      if (depth === 0) return trimmed.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Best-effort repair of near-JSON.
 *
 * Deliberately conservative — these are the failures we have actually seen from
 * small local models, not speculative ones. Anything we cannot fix mechanically
 * goes back to the model with the validation error attached (the repair turn),
 * which is a far better fixer than a regex.
 */
export function repairJsonText(text: string): string {
  let out = text;
  // Trailing commas before a closer: {"a": 1,} / [1, 2,]
  out = out.replace(/,\s*([}\]])/g, '$1');
  // Single-quoted keys and string values → double-quoted. Only when the text
  // contains no double quotes at all, so we can't corrupt legitimate content.
  if (!out.includes('"') && out.includes("'")) {
    out = out.replace(/'/g, '"');
  }
  return out;
}

export interface ParseAttempt<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: unknown;
  readonly rawText: string;
}

/**
 * The single validation point for EVERY provider.
 *
 * `advisory` is whatever parsed object the provider handed us (Anthropic's
 * `parsed_output`, OpenAI's parsed content). We do not trust it — we validate
 * it. If it's absent or wrong, we fall back to parsing the text.
 */
export function parseStructured<T>(options: {
  schema: z.ZodType<T>;
  advisory?: unknown;
  text: string;
}): ParseAttempt<T> {
  const { schema, advisory, text } = options;

  if (advisory !== undefined && advisory !== null) {
    const direct = schema.safeParse(advisory);
    if (direct.success) return { ok: true, value: direct.data, rawText: text };
    // Fall through: the provider claimed a parse but it doesn't match the
    // schema. Anthropic's `parsed_output: null` lands here too.
  }

  const extracted = extractJson(text);
  if (extracted === null) {
    return { ok: false, error: new Error('no JSON object found in the response'), rawText: text };
  }

  for (const candidate of [extracted, repairJsonText(extracted)]) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      const result = schema.safeParse(parsed);
      if (result.success) return { ok: true, value: result.data, rawText: text };
      // Keep the zod error from the *parsed* candidate — it's the useful one.
      return { ok: false, error: result.error, rawText: text };
    } catch {
      // Not valid JSON — try the repaired form, then give up.
    }
  }

  return { ok: false, error: new Error('response was not valid JSON'), rawText: text };
}

/** Describe a validation failure well enough that the model can fix it. */
export function describeError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .map(issue => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
  }
  if (error instanceof Error) return `  - ${error.message}`;
  return '  - unknown validation error';
}

/** The instruction appended to the system prompt on the `prompt` path. */
export function jsonInstruction(schemaName: string, jsonSchema: Record<string, unknown>): string {
  return [
    `You must reply with a single JSON object named "${schemaName}" that conforms to this JSON Schema:`,
    '',
    JSON.stringify(jsonSchema, null, 2),
    '',
    'Reply with the raw JSON object and nothing else. No prose, no explanation, no markdown fences.',
  ].join('\n');
}

/** The follow-up turn when validation failed. */
export function repairInstruction(rawText: string, error: unknown): string {
  return [
    'Your previous reply did not conform to the required JSON Schema.',
    '',
    'Validation errors:',
    describeError(error),
    '',
    'Previous reply:',
    rawText.slice(0, 2000),
    '',
    'Reply again with ONLY the corrected JSON object. No prose, no markdown fences.',
  ].join('\n');
}
