import type { RunFilter, RunOptions } from '@lastshotlabs/slingshot-orchestration';

export const SLINGSHOT_KIND_SEARCH_ATTRIBUTE = 'SlingshotKind';
export const SLINGSHOT_NAME_SEARCH_ATTRIBUTE = 'SlingshotName';
export const SLINGSHOT_TENANT_ID_SEARCH_ATTRIBUTE = 'SlingshotTenantId';
export const SLINGSHOT_PRIORITY_SEARCH_ATTRIBUTE = 'SlingshotPriority';
export const SLINGSHOT_TAGS_SEARCH_ATTRIBUTE = 'SlingshotTags';

export const RESERVED_SEARCH_ATTRIBUTES = Object.freeze({
  [SLINGSHOT_KIND_SEARCH_ATTRIBUTE]: 'Keyword',
  [SLINGSHOT_NAME_SEARCH_ATTRIBUTE]: 'Keyword',
  [SLINGSHOT_TENANT_ID_SEARCH_ATTRIBUTE]: 'Keyword',
  [SLINGSHOT_PRIORITY_SEARCH_ATTRIBUTE]: 'Int',
  [SLINGSHOT_TAGS_SEARCH_ATTRIBUTE]: 'KeywordList',
});

function toBase64Url(value: string): string {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(`${normalized}${padding}`, 'base64').toString('utf8');
}

function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * Encode a single Slingshot run tag into a Temporal-safe visibility token.
 */
export function encodeTag(key: string, value: string): string {
  return `${toBase64Url(key)}=${toBase64Url(value)}`;
}

/**
 * Decode a tag token previously produced by `encodeTag()`.
 */
export function decodeTag(value: string): [string, string] {
  const delimiter = value.indexOf('=');
  if (delimiter === -1) {
    return [value, ''];
  }
  return [fromBase64Url(value.slice(0, delimiter)), fromBase64Url(value.slice(delimiter + 1))];
}

/**
 * Encode a tag map into stable, sorted Temporal visibility values.
 */
export function encodeTags(tags?: Record<string, string>): string[] {
  if (!tags) return [];
  return Object.entries(tags)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => encodeTag(key, value));
}

/**
 * Decode Temporal visibility values back into a plain tag object.
 */
export function decodeTags(values?: unknown): Record<string, string> | undefined {
  if (!Array.isArray(values)) return undefined;
  const tags: Record<string, string> = {};
  for (const item of values) {
    if (typeof item !== 'string') continue;
    const [key, value] = decodeTag(item);
    tags[key] = value;
  }
  return Object.keys(tags).length === 0 ? undefined : tags;
}

/**
 * Build the Temporal search attributes written for a Slingshot run.
 */
export function buildSearchAttributes(
  kind: 'task' | 'workflow',
  name: string,
  opts?: Pick<RunOptions, 'tenantId' | 'priority' | 'tags'>,
): Record<string, string[] | number[]> {
  const attributes: Record<string, string[] | number[]> = {
    [SLINGSHOT_KIND_SEARCH_ATTRIBUTE]: [kind],
    [SLINGSHOT_NAME_SEARCH_ATTRIBUTE]: [name],
  };

  if (opts?.tenantId) {
    attributes[SLINGSHOT_TENANT_ID_SEARCH_ATTRIBUTE] = [opts.tenantId];
  }

  if (typeof opts?.priority === 'number') {
    attributes[SLINGSHOT_PRIORITY_SEARCH_ATTRIBUTE] = [opts.priority];
  }

  const tags = encodeTags(opts?.tags);
  if (tags.length > 0) {
    attributes[SLINGSHOT_TAGS_SEARCH_ATTRIBUTE] = tags;
  }

  return attributes;
}

/**
 * Translate a portable run filter into a Temporal visibility query string.
 */
export function buildVisibilityQuery(filter?: RunFilter): string | undefined {
  if (!filter) return undefined;

  const clauses: string[] = [];
  if (filter.type) {
    clauses.push(`${SLINGSHOT_KIND_SEARCH_ATTRIBUTE} = ${quote(filter.type)}`);
  }
  if (filter.name) {
    clauses.push(`${SLINGSHOT_NAME_SEARCH_ATTRIBUTE} = ${quote(filter.name)}`);
  }
  if (filter.tenantId) {
    clauses.push(`${SLINGSHOT_TENANT_ID_SEARCH_ATTRIBUTE} = ${quote(filter.tenantId)}`);
  }
  if (filter.status) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    const query = statuses.map(status => `ExecutionStatus = ${quote(toTemporalStatus(status))}`);
    if (query.length > 0) {
      clauses.push(query.length === 1 ? query[0] : `(${query.join(' OR ')})`);
    }
  }
  if (filter.createdAfter) {
    clauses.push(`StartTime >= ${quote(filter.createdAfter.toISOString())}`);
  }
  if (filter.createdBefore) {
    clauses.push(`StartTime <= ${quote(filter.createdBefore.toISOString())}`);
  }
  for (const value of encodeTags(filter.tags)) {
    clauses.push(`${SLINGSHOT_TAGS_SEARCH_ATTRIBUTE} = ${quote(value)}`);
  }

  return clauses.length === 0 ? undefined : clauses.join(' AND ');
}

/**
 * Return simple probe queries that can be used to validate the required Temporal search
 * attributes are registered and queryable.
 */
export function buildVisibilityValidationQueries(): string[] {
  return [
    `${SLINGSHOT_KIND_SEARCH_ATTRIBUTE} = 'task' OR ${SLINGSHOT_KIND_SEARCH_ATTRIBUTE} = 'workflow'`,
    `${SLINGSHOT_NAME_SEARCH_ATTRIBUTE} = 'slingshot'`,
    `${SLINGSHOT_TENANT_ID_SEARCH_ATTRIBUTE} = 'tenant'`,
    `${SLINGSHOT_PRIORITY_SEARCH_ATTRIBUTE} >= 0 OR ${SLINGSHOT_PRIORITY_SEARCH_ATTRIBUTE} < 0`,
    `${SLINGSHOT_TAGS_SEARCH_ATTRIBUTE} = '${encodeTag('key', 'value')}'`,
  ];
}

function toTemporalStatus(
  status: NonNullable<RunFilter['status']> extends infer T ? (T extends readonly unknown[] ? never : T) : never,
): string {
  switch (status) {
    case 'pending':
    case 'running':
      return 'Running';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Canceled';
    case 'skipped':
      return 'Completed';
  }
}
