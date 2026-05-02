import type { OperationConfig, ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';

type JsonRecord = Record<string, unknown>;

function normalizeDateValue(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Convert `Date` field values to ISO-8601 strings for HTTP serialization.
 *
 * Iterates the entity's `date`-typed fields and replaces any `Date` instances with
 * their `.toISOString()` representation. Returns the original reference unchanged
 * if no conversions were needed.
 *
 * @param config - Resolved entity config defining which fields are date-typed.
 * @param value - A single entity record (plain object).
 * @returns The record with dates normalized, or the original object if unchanged.
 */
export function normalizeEntityRecordResult(config: ResolvedEntityConfig, value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value;
  }

  let changed = false;
  const record = value as JsonRecord;
  const normalized: JsonRecord = { ...record };

  for (const [fieldName, fieldDef] of Object.entries(config.fields)) {
    if (fieldDef.type !== 'date' || !(fieldName in record)) {
      continue;
    }
    const nextValue = normalizeDateValue(record[fieldName]);
    if (!Object.is(nextValue, record[fieldName])) {
      normalized[fieldName] = nextValue;
      changed = true;
    }
  }

  return changed ? normalized : value;
}

/**
 * Apply date normalization to each item in a paginated list result.
 *
 * Expects a `{ items: unknown[] }` shape. Returns the original reference unchanged
 * if no items required normalization.
 *
 * @param config - Resolved entity config defining which fields are date-typed.
 * @param value - A paginated result object with an `items` array.
 * @returns The list with normalized records, or the original object if unchanged.
 */
export function normalizeEntityListResult(config: ResolvedEntityConfig, value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value;
  }

  const page = value as JsonRecord;
  if (!Array.isArray(page.items)) {
    return value;
  }

  let changed = false;
  const items = page.items.map(item => {
    const normalizedItem = normalizeEntityRecordResult(config, item);
    if (!Object.is(normalizedItem, item)) {
      changed = true;
    }
    return normalizedItem;
  });

  return changed ? { ...page, items } : value;
}

/**
 * Normalize a named operation's HTTP result for JSON serialization.
 *
 * Only applies to `lookup` operations — other operation kinds return the value as-is.
 * For lookups, delegates to {@link normalizeEntityRecordResult} (single) or
 * {@link normalizeEntityListResult} (list) based on `opConfig.returns`.
 *
 * @param config - Resolved entity config.
 * @param opConfig - The operation config (only `kind: 'lookup'` triggers normalization).
 * @param value - The raw operation result.
 * @returns The normalized result.
 */
export function normalizeNamedOperationHttpResult(
  config: ResolvedEntityConfig,
  opConfig: OperationConfig,
  value: unknown,
): unknown {
  if (opConfig.kind !== 'lookup') {
    return value;
  }
  return opConfig.returns === 'one'
    ? normalizeEntityRecordResult(config, value)
    : normalizeEntityListResult(config, value);
}
