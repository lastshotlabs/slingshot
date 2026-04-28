import type { ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import type {
  EntityDashboardPageDeclaration,
  EntityDetailPageDeclaration,
  EntityFieldMeta,
  EntityFormPageDeclaration,
  EntityListPageDeclaration,
  EntityMeta,
  NavigationConfig,
  PageDeclaration,
  PageTitleField,
  PageTitleTemplate,
  ResolvedPageDeclaration,
} from './pageDeclarations';
import type { PageLoaderResult } from './types';

interface PageEntityAdapter {
  getById(id: string): Promise<unknown>;
  list(opts: {
    filter?: unknown;
    limit?: number;
    cursor?: string;
  }): Promise<{ items: unknown[]; cursor?: string; nextCursor?: string; hasMore?: boolean }>;
  [key: string]: unknown;
}

/**
 * P-SSR-3: Validate at plugin setup time that every entity referenced by a
 * page declaration has a registered adapter. Without this, missing adapters
 * surface only when the page is requested, returning a 500. Catching at setup
 * fails the plugin init with a descriptive message that includes the
 * offending page route.
 *
 * @param pages - The page declarations from `SsrPluginConfig.pages`.
 * @param adapters - The adapter map keyed by entity name.
 * @throws When any referenced entity is missing from `adapters`.
 */
export function validatePageAdapters(
  pages: Readonly<Record<string, PageDeclaration>>,
  adapters: Readonly<Record<string, PageEntityAdapter | undefined>>,
): void {
  const missing: Array<{ pageKey: string; route: string; entity: string }> = [];
  for (const [pageKey, page] of Object.entries(pages)) {
    const referenced = collectReferencedEntities(page);
    for (const entity of referenced) {
      if (!adapters[entity]) {
        missing.push({ pageKey, route: page.path, entity });
      }
    }
  }
  if (missing.length > 0) {
    const lines = missing.map(
      ({ pageKey, route, entity }) =>
        `  - page "${pageKey}" (route ${route}): no adapter registered for entity "${entity}"`,
    );
    throw new Error(
      `[slingshot-ssr] Missing entity adapters for ${missing.length} page reference${
        missing.length > 1 ? 's' : ''
      }:\n${lines.join('\n')}\nRegister these adapters before plugin setup completes.`,
    );
  }
}

const DEFAULT_BATCH_SIZE = 100;

function toText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return '';
}

/**
 * Error thrown when a page loader cannot resolve the requested entity record.
 */
export class PageNotFoundError extends Error {
  /** Entity name whose record lookup failed. */
  readonly entity: string;
  /** Route params used for the failed lookup. */
  readonly params: Readonly<Record<string, string>>;

  /**
   * Create a new not-found error for an entity-backed page.
   *
   * @param entity - Entity name whose record lookup failed.
   * @param params - Route params used during the lookup.
   */
  constructor(entity: string, params: Readonly<Record<string, string>>) {
    super(`${entity} not found for params ${JSON.stringify(params)}`);
    this.name = 'PageNotFoundError';
    this.entity = entity;
    this.params = params;
  }
}

/**
 * Resolve and execute the generated loader for a page declaration.
 *
 * @param declaration - The matched, resolved page declaration.
 * @param params - Route params extracted from the URL.
 * @param query - Parsed query-string values.
 * @param adapters - Entity adapters keyed by entity name.
 * @param entityConfigs - Registered entity configs keyed by entity name.
 * @param navigation - Optional shell/navigation config to pass through.
 * @returns A renderer-ready page loader result.
 */
export async function resolvePageLoader(
  declaration: ResolvedPageDeclaration,
  params: Readonly<Record<string, string>>,
  query: Readonly<Record<string, string>>,
  adapters: Readonly<Record<string, PageEntityAdapter>>,
  entityConfigs: ReadonlyMap<string, ResolvedEntityConfig>,
  navigation?: NavigationConfig,
): Promise<PageLoaderResult> {
  const resolvedDeclaration = declaration.declaration;

  switch (resolvedDeclaration.type) {
    case 'entity-list':
      return loadEntityList(
        declaration,
        resolvedDeclaration,
        params,
        query,
        adapters,
        entityConfigs,
        navigation,
      );
    case 'entity-detail':
      return loadEntityDetail(
        declaration,
        resolvedDeclaration,
        params,
        adapters,
        entityConfigs,
        navigation,
      );
    case 'entity-form':
      return loadEntityForm(
        declaration,
        resolvedDeclaration,
        params,
        adapters,
        entityConfigs,
        navigation,
      );
    case 'entity-dashboard':
      return loadEntityDashboard(
        declaration,
        resolvedDeclaration,
        adapters,
        entityConfigs,
        navigation,
      );
    case 'custom':
      return {
        declaration,
        data: { type: 'custom' },
        entityMeta: Object.freeze({}),
        meta: {
          title: resolveTitle(resolvedDeclaration.title, null),
        },
        ...(navigation ? { navigation } : {}),
        ...(resolvedDeclaration.revalidate !== undefined
          ? { revalidate: resolvedDeclaration.revalidate }
          : {}),
        ...(resolvedDeclaration.tags ? { tags: Object.freeze([...resolvedDeclaration.tags]) } : {}),
      };
  }
}

async function loadEntityList(
  resolved: ResolvedPageDeclaration,
  declaration: EntityListPageDeclaration,
  params: Readonly<Record<string, string>>,
  query: Readonly<Record<string, string>>,
  adapters: Readonly<Record<string, PageEntityAdapter>>,
  entityConfigs: ReadonlyMap<string, ResolvedEntityConfig>,
  navigation?: NavigationConfig,
): Promise<PageLoaderResult> {
  const queryValues = query as Readonly<Record<string, string | undefined>>;
  const adapter = requireAdapter(declaration.entity, adapters);
  const entityConfig = requireEntityConfig(declaration.entity, entityConfigs);
  const records = await enumerateRecords(adapter);
  const filtered = applyListFilters(records, declaration, query);
  const sorted = sortRecords(
    filtered,
    queryValues.sort ?? declaration.defaultSort?.field,
    queryValues.order ?? declaration.defaultSort?.order ?? 'desc',
  );
  const page = Math.max(1, Number.parseInt(queryValues.page ?? '1', 10) || 1);
  const pageSize = declaration.pageSize ?? 20;
  const offset = (page - 1) * pageSize;
  const items = Object.freeze(
    sorted.slice(offset, offset + pageSize).map(item => Object.freeze({ ...item })),
  );

  return {
    declaration: resolved,
    data: {
      type: 'list',
      items,
      total: sorted.length,
      page,
      pageSize,
    },
    entityMeta: buildEntityMetaRecord(new Set([declaration.entity]), entityConfigs),
    meta: {
      title: resolveTitle(declaration.title, null),
    },
    ...(navigation ? { navigation } : {}),
    ...(declaration.revalidate !== undefined ? { revalidate: declaration.revalidate } : {}),
    tags: resolvePageTags(declaration, params, entityConfig),
  };
}

async function loadEntityDetail(
  resolved: ResolvedPageDeclaration,
  declaration: EntityDetailPageDeclaration,
  params: Readonly<Record<string, string>>,
  adapters: Readonly<Record<string, PageEntityAdapter>>,
  entityConfigs: ReadonlyMap<string, ResolvedEntityConfig>,
  navigation?: NavigationConfig,
): Promise<PageLoaderResult> {
  const adapter = requireAdapter(declaration.entity, adapters);
  const entityConfig = requireEntityConfig(declaration.entity, entityConfigs);
  const item = await resolveEntityRecord(declaration, params, adapter, entityConfig);

  if (!item) {
    throw new PageNotFoundError(declaration.entity, params);
  }

  return {
    declaration: resolved,
    data: {
      type: 'detail',
      item: Object.freeze({ ...item }),
    },
    entityMeta: buildEntityMetaRecord(collectReferencedEntities(declaration), entityConfigs),
    meta: {
      title: resolveTitle(declaration.title, item),
    },
    ...(navigation ? { navigation } : {}),
    ...(declaration.revalidate !== undefined ? { revalidate: declaration.revalidate } : {}),
    tags: resolvePageTags(declaration, params, entityConfig, item),
  };
}

async function loadEntityForm(
  resolved: ResolvedPageDeclaration,
  declaration: EntityFormPageDeclaration,
  params: Readonly<Record<string, string>>,
  adapters: Readonly<Record<string, PageEntityAdapter>>,
  entityConfigs: ReadonlyMap<string, ResolvedEntityConfig>,
  navigation?: NavigationConfig,
): Promise<PageLoaderResult> {
  const entityConfig = requireEntityConfig(declaration.entity, entityConfigs);

  if (declaration.operation === 'create') {
    const defaults = Object.freeze(
      Object.fromEntries(
        Object.entries(declaration.fieldConfig ?? {})
          .filter(([, config]) => config.defaultValue !== undefined)
          .map(([fieldName, config]) => [fieldName, config.defaultValue]),
      ),
    );

    return {
      declaration: resolved,
      data: {
        type: 'form-create',
        defaults,
      },
      entityMeta: buildEntityMetaRecord(new Set([declaration.entity]), entityConfigs),
      meta: {
        title: resolveTitle(declaration.title, null),
      },
      ...(navigation ? { navigation } : {}),
      ...(declaration.revalidate !== undefined ? { revalidate: declaration.revalidate } : {}),
      tags: resolvePageTags(declaration, params, entityConfig),
    };
  }

  const adapter = requireAdapter(declaration.entity, adapters);
  const item = await resolveEntityRecord(declaration, params, adapter, entityConfig);
  if (!item) {
    throw new PageNotFoundError(declaration.entity, params);
  }

  return {
    declaration: resolved,
    data: {
      type: 'form-edit',
      item: Object.freeze({ ...item }),
    },
    entityMeta: buildEntityMetaRecord(new Set([declaration.entity]), entityConfigs),
    meta: {
      title: resolveTitle(declaration.title, item),
    },
    ...(navigation ? { navigation } : {}),
    ...(declaration.revalidate !== undefined ? { revalidate: declaration.revalidate } : {}),
    tags: resolvePageTags(declaration, params, entityConfig, item),
  };
}

async function loadEntityDashboard(
  resolved: ResolvedPageDeclaration,
  declaration: EntityDashboardPageDeclaration,
  adapters: Readonly<Record<string, PageEntityAdapter>>,
  entityConfigs: ReadonlyMap<string, ResolvedEntityConfig>,
  navigation?: NavigationConfig,
): Promise<PageLoaderResult> {
  // P-SSR-5: use Promise.allSettled so a single flaky stat does not collapse
  // the whole dashboard. Per-stat failures surface as `value: null` and a
  // serialized `error` placeholder; the rendered page shows the stats that
  // succeeded with a clearly-marked error placeholder for the failed ones.
  const settled = await Promise.allSettled(
    declaration.stats.map(async stat => {
      const records = await enumerateRecords(requireAdapter(stat.entity, adapters));
      return aggregateRecords(records, stat.aggregate, stat.field, stat.filter);
    }),
  );
  const statResults = settled.map((outcome, i) => {
    const stat = declaration.stats[i];
    if (outcome.status === 'fulfilled') {
      return Object.freeze({ label: stat.label, value: outcome.value });
    }
    const err = outcome.reason;
    const errorInfo = Object.freeze({
      message: err instanceof Error ? err.message : String(err),
      name: err instanceof Error ? err.name : 'Error',
    });
    return Object.freeze({ label: stat.label, value: null, error: errorInfo });
  });

  let activity: readonly Record<string, unknown>[] | undefined;
  if (declaration.activity) {
    const activityConfig = declaration.activity;
    const records = await enumerateRecords(requireAdapter(activityConfig.entity, adapters));
    const sortField = activityConfig.sortField ?? inferTimestampField(records);
    const sorted = sortRecords(records, sortField, 'desc');
    activity = Object.freeze(
      sorted
        .slice(0, activityConfig.limit ?? 10)
        .map(item => Object.freeze({ ...projectFields(item, activityConfig.fields) })),
    );
  }

  let chart: readonly Record<string, unknown>[] | undefined;
  if (declaration.chart) {
    const records = await enumerateRecords(requireAdapter(declaration.chart.entity, adapters));
    chart = Object.freeze(
      Object.entries(groupAggregateRecords(records, declaration.chart)).map(([category, value]) =>
        Object.freeze({
          category,
          value,
        }),
      ),
    );
  }

  return {
    declaration: resolved,
    data: {
      type: 'dashboard',
      stats: Object.freeze(statResults),
      ...(activity ? { activity } : {}),
      ...(chart ? { chart } : {}),
    },
    entityMeta: buildEntityMetaRecord(collectReferencedEntities(declaration), entityConfigs),
    meta: {
      title: resolveTitle(declaration.title, null),
    },
    ...(navigation ? { navigation } : {}),
    ...(declaration.revalidate !== undefined ? { revalidate: declaration.revalidate } : {}),
    tags: resolveDashboardTags(declaration),
  };
}

function requireAdapter(
  entityName: string,
  adapters: Readonly<Record<string, PageEntityAdapter>>,
): PageEntityAdapter {
  const adapter = (adapters as Readonly<Record<string, PageEntityAdapter | undefined>>)[entityName];
  if (!adapter) {
    throw new Error(`[slingshot-ssr] No adapter registered for entity "${entityName}".`);
  }
  return adapter;
}

function requireEntityConfig(
  entityName: string,
  entityConfigs: ReadonlyMap<string, ResolvedEntityConfig>,
): ResolvedEntityConfig {
  const entityConfig = entityConfigs.get(entityName);
  if (!entityConfig) {
    throw new Error(`[slingshot-ssr] No entity config registered for "${entityName}".`);
  }
  return entityConfig;
}

async function resolveEntityRecord(
  declaration: EntityDetailPageDeclaration | EntityFormPageDeclaration,
  params: Readonly<Record<string, string>>,
  adapter: PageEntityAdapter,
  entityConfig: ResolvedEntityConfig,
): Promise<Record<string, unknown> | null> {
  if (!declaration.lookup || declaration.lookup === 'id') {
    const paramValues = params as Readonly<Record<string, string | undefined>>;
    const id = paramValues.id ?? paramValues[entityConfig._pkField];
    if (!id) return null;
    return toRecord(await adapter.getById(id));
  }

  const lookupOperation = adapter[declaration.lookup];
  if (typeof lookupOperation !== 'function') {
    throw new Error(
      `[slingshot-ssr] Adapter for "${declaration.entity}" does not expose lookup "${declaration.lookup}".`,
    );
  }

  const result = await (
    lookupOperation as (input: Readonly<Record<string, string>>) => Promise<unknown>
  )(params);
  return toRecord(result);
}

async function enumerateRecords(adapter: PageEntityAdapter): Promise<Record<string, unknown>[]> {
  const records: Record<string, unknown>[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (;;) {
    const batch = await adapter.list({
      limit: DEFAULT_BATCH_SIZE,
      ...(cursor ? { cursor } : {}),
    });

    for (const item of batch.items) {
      const record = toRecord(item);
      if (record) {
        records.push(record);
      }
    }

    const nextCursor =
      typeof batch.nextCursor === 'string'
        ? batch.nextCursor
        : typeof batch.cursor === 'string'
          ? batch.cursor
          : undefined;

    if (!batch.hasMore || !nextCursor || seenCursors.has(nextCursor)) {
      break;
    }

    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return records;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function applyListFilters(
  records: readonly Record<string, unknown>[],
  declaration: EntityListPageDeclaration,
  query: Readonly<Record<string, string>>,
): Record<string, unknown>[] {
  let filtered = [...records];
  const queryValues = query as Readonly<Record<string, string | undefined>>;

  if (declaration.searchable && queryValues.q) {
    const search = queryValues.q.toLowerCase();
    filtered = filtered.filter(record =>
      declaration.fields.some(fieldName =>
        toText(record[fieldName]).toLowerCase().includes(search),
      ),
    );
  }

  for (const filter of declaration.filters ?? []) {
    const rawValue = queryValues[`filter_${filter.field}`];
    if (rawValue === undefined) continue;

    filtered = filtered.filter(record =>
      matchesFilter(record[filter.field], rawValue, filter.operator ?? 'eq'),
    );
  }

  return filtered;
}

function matchesFilter(
  value: unknown,
  rawExpected: string,
  operator: NonNullable<EntityListPageDeclaration['filters']>[number]['operator'],
): boolean {
  switch (operator) {
    case 'contains':
      return toText(value).toLowerCase().includes(rawExpected.toLowerCase());
    case 'gt':
      return compareValues(value, rawExpected) > 0;
    case 'lt':
      return compareValues(value, rawExpected) < 0;
    case 'gte':
      return compareValues(value, rawExpected) >= 0;
    case 'lte':
      return compareValues(value, rawExpected) <= 0;
    case 'in':
      return rawExpected
        .split(',')
        .map(entry => entry.trim())
        .includes(toText(value));
    case 'eq':
    default:
      return toText(value) === rawExpected;
  }
}

function sortRecords(
  records: readonly Record<string, unknown>[],
  fieldName: string | undefined,
  order: string,
): Record<string, unknown>[] {
  if (!fieldName) {
    return [...records];
  }

  const direction = order === 'asc' ? 1 : -1;
  return [...records].sort(
    (left, right) => compareValues(left[fieldName], right[fieldName]) * direction,
  );
}

function compareValues(left: unknown, right: unknown): number {
  const leftNumber = typeof left === 'number' ? left : Number(left);
  const rightNumber = typeof right === 'number' ? right : Number(right);

  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber - rightNumber;
  }

  return toText(left).localeCompare(toText(right));
}

function buildEntityMetaRecord(
  entityNames: ReadonlySet<string>,
  entityConfigs: ReadonlyMap<string, ResolvedEntityConfig>,
): Readonly<Record<string, EntityMeta>> {
  const result: Record<string, EntityMeta> = {};

  for (const entityName of entityNames) {
    const entityConfig = entityConfigs.get(entityName);
    if (!entityConfig) continue;

    const fields: Record<string, EntityFieldMeta> = {};
    for (const [fieldName, fieldDef] of Object.entries(entityConfig.fields)) {
      fields[fieldName] = Object.freeze({
        name: fieldName,
        type: fieldDef.type,
        optional: fieldDef.optional,
        primary: fieldDef.primary,
        immutable: fieldDef.immutable,
        ...(fieldDef.enumValues ? { enumValues: fieldDef.enumValues } : {}),
      });
    }

    result[entityName] = Object.freeze({
      name: entityConfig.name,
      ...(entityConfig.namespace ? { namespace: entityConfig.namespace } : {}),
      fields: Object.freeze(fields),
      ...(entityConfig.softDelete ? { softDelete: entityConfig.softDelete } : {}),
    });
  }

  return Object.freeze(result);
}

function collectReferencedEntities(declaration: PageDeclaration): Set<string> {
  const entities = new Set<string>();

  switch (declaration.type) {
    case 'entity-list':
    case 'entity-detail':
    case 'entity-form':
      entities.add(declaration.entity);
      if (declaration.type === 'entity-detail') {
        for (const related of declaration.related ?? []) {
          entities.add(related.entity);
        }
      }
      break;
    case 'entity-dashboard':
      for (const stat of declaration.stats) {
        entities.add(stat.entity);
      }
      if (declaration.activity) entities.add(declaration.activity.entity);
      if (declaration.chart) entities.add(declaration.chart.entity);
      break;
    case 'custom':
      break;
  }

  return entities;
}

function resolveTitle(
  title: string | PageTitleField | PageTitleTemplate,
  item: Record<string, unknown> | null,
): string {
  if (typeof title === 'string') return title;
  if ('field' in title) {
    return item ? toText(item[title.field]) : '';
  }
  return item
    ? title.template.replace(/\{(\w+)\}/g, (_match, key: string) => toText(item[key]))
    : title.template;
}

function resolvePageTags(
  declaration: EntityListPageDeclaration | EntityDetailPageDeclaration | EntityFormPageDeclaration,
  params: Readonly<Record<string, string>>,
  entityConfig: ResolvedEntityConfig,
  item?: Record<string, unknown>,
): readonly string[] {
  if (declaration.tags) {
    return Object.freeze(interpolateTags(declaration.tags, params));
  }

  const tags = new Set<string>([`entity:${declaration.entity}`]);
  if (item && declaration.type !== 'entity-list') {
    const recordId = item[entityConfig._pkField];
    if (recordId !== undefined && recordId !== null) {
      const tagRecordId = toText(recordId);
      if (tagRecordId !== '') {
        tags.add(`entity:${declaration.entity}:${tagRecordId}`);
      }
    }
  }
  return Object.freeze([...tags]);
}

function resolveDashboardTags(declaration: EntityDashboardPageDeclaration): readonly string[] {
  if (declaration.tags) {
    return Object.freeze([...declaration.tags]);
  }

  const tags = new Set<string>();
  for (const entityName of collectReferencedEntities(declaration)) {
    tags.add(`entity:${entityName}`);
  }
  return Object.freeze([...tags]);
}

function interpolateTags(
  tags: readonly string[],
  params: Readonly<Record<string, string>>,
): string[] {
  return tags.map(tag => tag.replace(/\{(\w+)\}/g, (_match, key: string) => params[key] ?? ''));
}

function aggregateRecords(
  records: readonly Record<string, unknown>[],
  aggregate: 'count' | 'sum' | 'avg' | 'min' | 'max',
  field?: string,
  filter?: Readonly<Record<string, unknown>>,
): number {
  const filtered = filter
    ? records.filter(record =>
        Object.entries(filter).every(([key, value]) => record[key] === value),
      )
    : records;

  if (aggregate === 'count') {
    return filtered.length;
  }

  const numbers = filtered
    .map(record => Number(field ? record[field] : undefined))
    .filter(value => Number.isFinite(value));

  if (numbers.length === 0) return 0;

  switch (aggregate) {
    case 'sum':
      return numbers.reduce((sum, value) => sum + value, 0);
    case 'avg':
      return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
    case 'min':
      return Math.min(...numbers);
    case 'max':
      return Math.max(...numbers);
  }
}

function inferTimestampField(records: readonly Record<string, unknown>[]): string | undefined {
  if (records.some(record => 'createdAt' in record)) return 'createdAt';
  if (records.some(record => 'updatedAt' in record)) return 'updatedAt';
  return undefined;
}

function projectFields(
  record: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const fieldName of fields) {
    result[fieldName] = record[fieldName];
  }
  return result;
}

function groupAggregateRecords(
  records: readonly Record<string, unknown>[],
  chart: EntityDashboardPageDeclaration['chart'],
): Record<string, number> {
  if (!chart) return {};

  const grouped: Record<string, number[] | undefined> = {};
  for (const record of records) {
    const category = toText(record[chart.categoryField]);
    const value = chart.aggregate === 'count' ? 1 : Number(record[chart.valueField] ?? 0);

    const values = (grouped[category] ??= []);

    if (Number.isFinite(value)) {
      values.push(value);
    }
  }

  return Object.fromEntries(
    Object.entries(grouped).map(([category, values]) => {
      const bucket = values ?? [];
      const value =
        chart.aggregate === 'avg'
          ? bucket.reduce((sum, item) => sum + item, 0) / bucket.length
          : bucket.reduce((sum, item) => sum + item, 0);
      return [category, value];
    }),
  );
}
