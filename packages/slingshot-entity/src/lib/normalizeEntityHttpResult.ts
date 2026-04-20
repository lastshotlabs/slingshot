import type { OperationConfig, ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';

type JsonRecord = Record<string, unknown>;

function normalizeDateValue(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

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
