import {
  type EntityAdapter,
  type EntityBackendCapability,
  deepFreeze,
} from '@lastshotlabs/slingshot-core';
import type { EntityConformanceCase, EntityConformanceHarness } from './conformance';
import {
  CONFORMANCE_COMPOSITE_KEY,
  CONFORMANCE_RECORDS_KEY,
  CONFORMANCE_SOFT_DELETE_KEY,
  CONFORMANCE_TENANTS_KEY,
  CONFORMANCE_TTL_KEY,
  CONFORMANCE_VERSIONED_KEY,
  CONFORMANCE_VERSIONED_OPTIONAL_KEY,
  CONFORMANCE_VERSIONED_SOFT_DELETE_KEY,
} from './fixtures';

type RecordValue = Record<string, unknown>;
type Adapter = EntityAdapter<RecordValue, RecordValue, RecordValue>;

function adapter(harness: EntityConformanceHarness, key = CONFORMANCE_RECORDS_KEY): Adapter {
  return harness.adapter<RecordValue, RecordValue, RecordValue>(key);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

function assertArrayEqual(
  actual: readonly unknown[],
  expected: readonly unknown[],
  message: string,
) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${message}: expected ${right}, received ${left}`);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => stableJson(item)).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function operation(
  target: Readonly<Record<string, unknown>>,
  name: string,
): (...args: readonly unknown[]) => Promise<unknown> {
  const method = target[name];
  if (typeof method !== 'function') {
    throw new Error(`Expected operation '${name}' to be installed`);
  }
  return method as (...args: readonly unknown[]) => Promise<unknown>;
}

function recordInput(id: string, overrides: RecordValue = {}): RecordValue {
  return {
    id,
    email: `${id}@example.test`,
    category: 'group-a',
    slug: id,
    title: `Title ${id}`,
    immutableCode: `immutable-${id}`,
    tags: [],
    metadata: { source: 'conformance' },
    ...overrides,
  };
}

async function expectConflict(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch (error) {
    assert(
      typeof error === 'object' && error !== null,
      'Conflict must reject with an error object',
    );
    assertEqual(Reflect.get(error, 'status'), 409, 'Conflict status');
    return;
  }
  throw new Error('Expected a 409 conflict rejection');
}

async function expectErrorCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    assertEqual(Reflect.get(error as object, 'code'), code, 'Error code');
    return;
  }
  throw new Error(`Expected rejection with code ${code}`);
}

function defineCase(
  id: string,
  description: string,
  requires: readonly EntityBackendCapability[],
  run: (harness: EntityConformanceHarness) => Promise<void>,
): EntityConformanceCase {
  return deepFreeze({ id, description, requires: [...requires], run });
}

function defineNativeTransactionRollbackCase(
  id: string,
  description: string,
  requires: readonly EntityBackendCapability[],
  operationName: string,
  initial: RecordValue,
  params: RecordValue,
  verify: (record: RecordValue) => void,
): EntityConformanceCase {
  return defineCase(id, description, requires, async harness => {
    const target = adapter(harness);
    const recordId = `tx-native-${id.split('.').at(-1)}`;
    await target.create(recordInput(recordId, initial));
    await expectConflict(
      operation(
        harness.composite(CONFORMANCE_COMPOSITE_KEY),
        operationName,
      )({ id: recordId, missingId: 'missing', ...params }),
    );
    const restored = await target.getById(recordId);
    assert(restored, `${description}: rolled-back record must still exist`);
    verify(restored);
  });
}

const CRUD = [
  defineCase(
    'crud.strict-create',
    'create persists and returns the supplied record',
    ['crud.create'],
    async harness => {
      const created = await adapter(harness).create(recordInput('create-1'));
      assertEqual(created.id, 'create-1', 'Created primary key');
      assertEqual(created.title, 'Title create-1', 'Created title');
    },
  ),
  defineCase(
    'crud.generated-defaults',
    'create applies literal and generated defaults',
    ['crud.create', 'defaults.apply'],
    async harness => {
      const created = await adapter(harness).create(recordInput('defaults-1'));
      assertEqual(created.status, 'pending', 'Literal default');
      assertEqual(created.count, 0, 'Integer default');
      assertEqual(created.active, true, 'Boolean default');
      assert(created.occurredAt instanceof Date, 'Date default must resolve to a Date');
    },
  ),
  defineCase(
    'crud.read-missing',
    'read returns null for a missing primary key',
    ['crud.read'],
    async harness => {
      assertEqual(await adapter(harness).getById('missing'), null, 'Missing read');
    },
  ),
  defineCase(
    'crud.update-missing',
    'update returns null for a missing primary key',
    ['crud.update'],
    async harness => {
      assertEqual(
        await adapter(harness).update('missing', { title: 'none' }),
        null,
        'Missing update',
      );
    },
  ),
  defineCase(
    'crud.delete-result',
    'delete reports true once and removes the record',
    ['crud.create', 'crud.read', 'crud.delete'],
    async harness => {
      const target = adapter(harness);
      await target.create(recordInput('delete-1'));
      assertEqual(await target.delete('delete-1'), true, 'First delete');
      assertEqual(await target.getById('delete-1'), null, 'Deleted record visibility');
    },
  ),
  defineCase(
    'crud.clear',
    'clear removes every record',
    ['crud.create', 'crud.list', 'crud.clear'],
    async harness => {
      const target = adapter(harness);
      await target.create(recordInput('clear-1'));
      await target.create(recordInput('clear-2'));
      await target.clear();
      assertEqual((await target.list()).items.length, 0, 'Records after clear');
    },
  ),
  defineCase(
    'crud.primary-duplicate-conflict',
    'duplicate primary-key create rejects without replacement',
    ['crud.create'],
    async harness => {
      const target = adapter(harness);
      await target.create(recordInput('duplicate-1', { title: 'original' }));
      await expectConflict(
        target.create(
          recordInput('duplicate-1', { email: 'other@example.test', title: 'replacement' }),
        ),
      );
      assertEqual(
        (await target.getById('duplicate-1'))?.title,
        'original',
        'Original row after conflict',
      );
    },
  ),
] as const;

const MAPPING_AND_CONSTRAINTS = [
  defineCase(
    'mapping.scalar-round-trip',
    'mapped scalar, date, JSON, and array values round trip',
    ['crud.create', 'crud.read', 'mapping.fields'],
    async harness => {
      const occurredAt = new Date('2025-02-03T04:05:06.000Z');
      const target = adapter(harness);
      await target.create(
        recordInput('types-1', {
          score: 4.25,
          count: 7,
          active: false,
          occurredAt,
          metadata: { nested: { ok: true }, count: 2 },
          tags: ['one', 'two'],
        }),
      );
      const found = await target.getById('types-1');
      assert(found, 'Typed record must exist');
      assertEqual(found.score, 4.25, 'Number round trip');
      assertEqual(found.count, 7, 'Integer round trip');
      assertEqual(found.active, false, 'Boolean round trip');
      assertEqual(
        (found.occurredAt as Date).toISOString(),
        occurredAt.toISOString(),
        'Date round trip',
      );
      assertArrayEqual(found.tags as unknown[], ['one', 'two'], 'Array round trip');
      assertEqual(
        stableJson(found.metadata),
        stableJson({ nested: { ok: true }, count: 2 }),
        'JSON round trip',
      );
    },
  ),
  defineCase(
    'mapping.nullability',
    'optional fields preserve explicit null updates',
    ['crud.create', 'crud.update', 'crud.read', 'mapping.fields'],
    async harness => {
      const target = adapter(harness);
      await target.create(recordInput('null-1', { nullableNote: 'present' }));
      const updated = await target.update('null-1', { nullableNote: null });
      assertEqual(updated?.nullableNote, null, 'Nullable update');
    },
  ),
  defineCase(
    'mapping.immutable-field',
    'ordinary updates preserve immutable fields',
    ['crud.create', 'crud.update', 'mapping.fields'],
    async harness => {
      const target = adapter(harness);
      await target.create(recordInput('immutable-1'));
      const updated = await target.update('immutable-1', { title: 'changed' });
      assertEqual(updated?.immutableCode, 'immutable-immutable-1', 'Immutable field after update');
    },
  ),
  defineCase(
    'uniqueness.single-field',
    'single-field unique conflicts reject with HTTP 409',
    ['crud.create', 'constraint.unique'],
    async harness => {
      const target = adapter(harness);
      await target.create(recordInput('unique-1', { email: 'same@example.test' }));
      await expectConflict(target.create(recordInput('unique-2', { email: 'same@example.test' })));
    },
  ),
  defineCase(
    'uniqueness.compound',
    'compound unique conflicts reject with HTTP 409',
    ['crud.create', 'constraint.unique'],
    async harness => {
      const target = adapter(harness);
      await target.create(recordInput('compound-1', { category: 'same', slug: 'same' }));
      await expectConflict(
        target.create(recordInput('compound-2', { category: 'same', slug: 'same' })),
      );
    },
  ),
  defineCase(
    'uniqueness.update-preserves-original',
    'conflicting update rejects and preserves both original rows',
    ['crud.create', 'crud.update', 'constraint.unique'],
    async harness => {
      const target = adapter(harness);
      await target.create(recordInput('update-unique-1', { email: 'first@example.test' }));
      await target.create(recordInput('update-unique-2', { email: 'second@example.test' }));
      await expectConflict(target.update('update-unique-2', { email: 'first@example.test' }));
      assertEqual(
        (await target.getById('update-unique-1'))?.email,
        'first@example.test',
        'First unique row',
      );
      assertEqual(
        (await target.getById('update-unique-2'))?.email,
        'second@example.test',
        'Second unique row',
      );
    },
  ),
] as const;

const SCOPE_AND_LIFECYCLE = [
  defineCase(
    'tenancy.cross-tenant-denial',
    'tenant filters constrain get, update, delete, and list',
    ['crud.create', 'crud.read', 'crud.update', 'crud.delete', 'crud.list', 'scope.tenant'],
    async harness => {
      const target = adapter(harness, CONFORMANCE_TENANTS_KEY);
      await target.create({ id: 'tenant-1', tenantId: 'alpha', title: 'private' });
      assertEqual(await target.getById('tenant-1', { tenantId: 'beta' }), null, 'Cross-tenant get');
      assertEqual(
        await target.update('tenant-1', { title: 'changed' }, { tenantId: 'beta' }),
        null,
        'Cross-tenant update',
      );
      assertEqual(
        await target.delete('tenant-1', { tenantId: 'beta' }),
        false,
        'Cross-tenant delete',
      );
      assertEqual(
        (await target.list({ filter: { tenantId: 'beta' } })).items.length,
        0,
        'Cross-tenant list',
      );
      assertEqual(
        (await target.getById('tenant-1', { tenantId: 'alpha' }))?.title,
        'private',
        'Matching tenant',
      );
    },
  ),
  defineCase(
    'lifecycle.soft-delete-visibility',
    'soft-deleted records are hidden from public reads',
    ['crud.create', 'crud.read', 'crud.delete', 'crud.list', 'lifecycle.soft-delete'],
    async harness => {
      const target = adapter(harness, CONFORMANCE_SOFT_DELETE_KEY);
      await target.create({ id: 'soft-1', title: 'visible' });
      assertEqual(await target.delete('soft-1'), true, 'Soft delete result');
      assertEqual(await target.getById('soft-1'), null, 'Soft-deleted get');
      assertEqual((await target.list()).items.length, 0, 'Soft-deleted list');
      assertEqual(await target.delete('soft-1'), false, 'Repeated soft delete');
    },
  ),
  defineCase(
    'lifecycle.ttl-visibility',
    'expired records are hidden without relying on cleanup timing',
    ['crud.create', 'crud.read', 'crud.list', 'lifecycle.ttl-visibility'],
    async harness => {
      const target = adapter(harness, CONFORMANCE_TTL_KEY);
      await target.create({ id: 'ttl-1', title: 'short-lived' });
      await new Promise(resolve => setTimeout(resolve, 35));
      assertEqual(await target.getById('ttl-1'), null, 'Expired get');
      assertEqual((await target.list()).items.length, 0, 'Expired list');
    },
  ),
] as const;

const QUERY = [
  defineCase(
    'filters.complete-operator-set',
    'list implements equality and every declared filter operator',
    [
      'crud.create',
      'crud.list',
      'filter.eq',
      'filter.ne',
      'filter.gt',
      'filter.gte',
      'filter.lt',
      'filter.lte',
      'filter.in',
      'filter.nin',
      'filter.contains',
      'filter.and',
      'filter.or',
    ],
    async harness => {
      const target = adapter(harness);
      await target.create(recordInput('filter-1', { title: 'Alpha One', score: 1, category: 'a' }));
      await target.create(recordInput('filter-2', { title: 'Beta Two', score: 2, category: 'b' }));
      await target.create(
        recordInput('filter-3', { title: 'Gamma Three', score: 3, category: 'c' }),
      );
      const ids = async (filter: RecordValue) =>
        (await target.list({ filter, limit: 50 })).items.map(item => item.id).sort();
      assertArrayEqual(await ids({ score: 2 }), ['filter-2'], 'Equality');
      assertArrayEqual(await ids({ score: { $ne: 2 } }), ['filter-1', 'filter-3'], '$ne');
      assertArrayEqual(await ids({ score: { $gt: 2 } }), ['filter-3'], '$gt');
      assertArrayEqual(await ids({ score: { $gte: 2 } }), ['filter-2', 'filter-3'], '$gte');
      assertArrayEqual(await ids({ score: { $lt: 2 } }), ['filter-1'], '$lt');
      assertArrayEqual(await ids({ score: { $lte: 2 } }), ['filter-1', 'filter-2'], '$lte');
      assertArrayEqual(await ids({ score: { $in: [1, 3] } }), ['filter-1', 'filter-3'], '$in');
      assertArrayEqual(await ids({ score: { $nin: [1, 3] } }), ['filter-2'], '$nin');
      assertArrayEqual(await ids({ title: { $contains: 'two' } }), ['filter-2'], '$contains');
      assertArrayEqual(
        await ids({ $and: [{ score: { $gte: 2 } }, { score: { $lte: 2 } }] }),
        ['filter-2'],
        '$and',
      );
      assertArrayEqual(
        await ids({ $or: [{ score: 1 }, { score: 3 }] }),
        ['filter-1', 'filter-3'],
        '$or',
      );
    },
  ),
  defineCase(
    'query.deterministic-sort',
    'multi-column cursor fields produce deterministic ordering',
    ['crud.create', 'crud.list', 'query.sort'],
    async harness => {
      const target = adapter(harness);
      await target.create(recordInput('sort-c', { category: 'b' }));
      await target.create(recordInput('sort-b', { category: 'a' }));
      await target.create(recordInput('sort-a', { category: 'a' }));
      const result = await target.list({ limit: 50 });
      assertArrayEqual(
        result.items.map(item => item.id),
        ['sort-a', 'sort-b', 'sort-c'],
        'Sorted ids',
      );
    },
  ),
  defineCase(
    'query.stable-cursor',
    'cursor traversal has no duplicate or missing records',
    ['crud.create', 'crud.list', 'query.sort', 'query.cursor'],
    async harness => {
      const target = adapter(harness);
      for (let index = 0; index < 7; index++) {
        await target.create(
          recordInput(`cursor-${index}`, { category: `g-${Math.floor(index / 2)}` }),
        );
      }
      const seen: unknown[] = [];
      let cursor: string | undefined;
      do {
        const page = await target.list({ limit: 2, ...(cursor ? { cursor } : {}) });
        seen.push(...page.items.map(item => item.id));
        cursor = page.nextCursor;
      } while (cursor);
      assertEqual(new Set(seen).size, 7, 'Unique cursor records');
      assertEqual(seen.length, 7, 'Complete cursor records');
    },
  ),
] as const;

const NAMED_OPERATIONS = [
  defineCase(
    'operation.lookup',
    'lookup returns one and many records',
    ['crud.create', 'operation.lookup'],
    async harness => {
      const target = adapter(harness);
      await target.create(recordInput('lookup-1', { category: 'lookup' }));
      await target.create(recordInput('lookup-2', { category: 'lookup' }));
      assertEqual(
        ((await operation(target, 'lookupOne')({ id: 'lookup-1' })) as RecordValue).id,
        'lookup-1',
        'Lookup one',
      );
      const many = (await operation(target, 'lookupMany')({ group: 'lookup' })) as {
        items: RecordValue[];
      };
      assertEqual(many.items.length, 2, 'Lookup many');
    },
  ),
  defineCase(
    'operation.exists',
    'exists reports whether a matching record is present',
    ['crud.create', 'operation.exists'],
    async harness => {
      const target = adapter(harness);
      await target.create(recordInput('exists-1'));
      assertEqual(
        await operation(target, 'existsByEmail')({ email: 'exists-1@example.test' }),
        true,
        'Existing record',
      );
      assertEqual(
        await operation(target, 'existsByEmail')({ email: 'missing@example.test' }),
        false,
        'Missing record',
      );
    },
  ),
  defineCase(
    'operation.aggregate',
    'aggregate computes count and numeric sum',
    ['crud.create', 'operation.aggregate'],
    async harness => {
      const target = adapter(harness);
      await target.create(recordInput('aggregate-1', { score: 2 }));
      await target.create(recordInput('aggregate-2', { score: 3 }));
      const result = (await operation(target, 'totals')({})) as RecordValue;
      assertEqual(result.total, 2, 'Aggregate count');
      assertEqual(result.score, 5, 'Aggregate sum');
    },
  ),
  defineCase(
    'operation.derive',
    'derive selects and merges matching source values',
    ['crud.create', 'operation.derive'],
    async harness => {
      const target = adapter(harness);
      await target.create(recordInput('derive-1', { category: 'derive', title: 'One' }));
      await target.create(recordInput('derive-2', { category: 'derive', title: 'Two' }));
      const result = (await operation(target, 'deriveTitles')({ group: 'derive' })) as unknown[];
      assertArrayEqual([...result].sort(), ['One', 'Two'], 'Derived titles');
    },
  ),
  defineCase(
    'operation.search',
    'search finds matching text with a stable result shape',
    ['crud.create', 'operation.search'],
    async harness => {
      const target = adapter(harness);
      await target.create(recordInput('search-1', { title: 'Needle document' }));
      await target.create(recordInput('search-2', { title: 'Other document' }));
      const result = (await operation(target, 'searchTitles')('needle')) as {
        items: RecordValue[];
      };
      assertArrayEqual(
        result.items.map(item => item.id),
        ['search-1'],
        'Search ids',
      );
    },
  ),
  defineCase(
    'operation.collection',
    'collection add, list, update, remove, and set agree',
    ['operation.collection'],
    async harness => {
      const target = adapter(harness);
      await operation(target, 'commentsAdd')('parent-1', { id: 'c1', body: 'one' });
      await operation(target, 'commentsUpdate')('parent-1', 'c1', { body: 'updated' });
      let items = (await operation(target, 'commentsList')('parent-1')) as RecordValue[];
      assertEqual(items[0]?.body, 'updated', 'Collection update');
      await operation(target, 'commentsSet')('parent-1', [{ id: 'c2', body: 'two' }]);
      items = (await operation(target, 'commentsList')('parent-1')) as RecordValue[];
      assertArrayEqual(
        items.map(item => item.id),
        ['c2'],
        'Collection set',
      );
      await operation(target, 'commentsRemove')('parent-1', 'c2');
      assertEqual(
        ((await operation(target, 'commentsList')('parent-1')) as unknown[]).length,
        0,
        'Collection remove',
      );
    },
  ),
  defineCase(
    'operation.custom',
    'custom active-store factories install callable methods',
    ['operation.custom'],
    async harness => {
      assertEqual(await operation(adapter(harness), 'ping')(), 'pong', 'Custom result');
    },
  ),
  defineCase(
    'operation.field-update',
    'field update changes only its declared fields',
    ['crud.create', 'operation.fieldUpdate'],
    async harness => {
      const target = adapter(harness);
      await target.create(recordInput('field-update-1'));
      const result = (await operation(target, 'guardedStatusUpdate')(
        { id: 'field-update-1', expectedStatus: 'pending' },
        { status: 'review' },
      )) as RecordValue;
      assertEqual(result.status, 'review', 'Field-update status');
      assertEqual(result.title, 'Title field-update-1', 'Field-update preserved title');
    },
  ),
  defineCase(
    'operation.transition',
    'transition applies once from the declared state',
    ['crud.create', 'operation.transition', 'atomic.transition'],
    async harness => {
      const target = adapter(harness);
      await target.create(recordInput('transition-1'));
      const first = (await operation(target, 'activate')({ id: 'transition-1' })) as RecordValue;
      assertEqual(first.status, 'active', 'Transitioned state');
      assertEqual(
        await operation(target, 'activate')({ id: 'transition-1' }),
        null,
        'Repeated transition',
      );
    },
  ),
  defineCase(
    'operation.increment',
    'increment atomically updates and returns the numeric field',
    ['crud.create', 'operation.increment', 'atomic.increment'],
    async harness => {
      const target = adapter(harness);
      await target.create(recordInput('increment-1'));
      const result = (await operation(target, 'incrementCount')('increment-1', 3)) as RecordValue;
      assertEqual(result.count, 3, 'Incremented count');
    },
  ),
  defineCase(
    'operation.array-mutation',
    'array push, pull, and set preserve deduplication semantics',
    [
      'crud.create',
      'operation.arrayPush',
      'operation.arrayPull',
      'operation.arraySet',
      'atomic.array-mutation',
    ],
    async harness => {
      const target = adapter(harness);
      await target.create(recordInput('array-1'));
      await operation(target, 'pushTag')('array-1', 'one');
      await operation(target, 'pushTag')('array-1', 'one');
      await operation(target, 'pushTag')('array-1', 'two');
      await operation(target, 'pullTag')('array-1', 'one');
      await operation(target, 'setTags')('array-1', ['two', 'two', 'three']);
      assertArrayEqual(
        (await target.getById('array-1'))?.tags as unknown[],
        ['two', 'three'],
        'Array operations',
      );
    },
  ),
  defineCase(
    'operation.consume',
    'consume returns and removes a record exactly once',
    ['crud.create', 'crud.read', 'operation.consume', 'atomic.consume'],
    async harness => {
      const target = adapter(harness);
      await target.create(recordInput('consume-1'));
      assertEqual(
        ((await operation(target, 'consumeById')({ id: 'consume-1' })) as RecordValue).id,
        'consume-1',
        'Consumed record',
      );
      assertEqual(
        await operation(target, 'consumeById')({ id: 'consume-1' }),
        null,
        'Repeated consume',
      );
      assertEqual(await target.getById('consume-1'), null, 'Consumed persistence');
    },
  ),
  defineCase(
    'operation.upsert',
    'upsert distinguishes creation from update',
    ['crud.read', 'operation.upsert', 'atomic.upsert'],
    async harness => {
      const target = adapter(harness);
      const first = (await operation(
        target,
        'upsertByEmail',
      )({
        email: 'upsert@example.test',
        category: 'upsert',
        slug: 'upsert',
        title: 'first',
        immutableCode: 'upsert-code',
      })) as { entity: RecordValue; created: boolean };
      const second = (await operation(
        target,
        'upsertByEmail',
      )({
        email: 'upsert@example.test',
        category: 'upsert',
        slug: 'upsert',
        title: 'second',
        immutableCode: 'upsert-code',
      })) as { entity: RecordValue; created: boolean };
      assertEqual(first.created, true, 'Upsert create flag');
      assertEqual(second.created, false, 'Upsert update flag');
      assertEqual(second.entity.title, 'second', 'Upsert updated value');
    },
  ),
  defineCase(
    'operation.batch',
    'batch updates every selected record and reports the count',
    ['crud.create', 'crud.read', 'operation.batch', 'atomic.batch'],
    async harness => {
      const target = adapter(harness);
      await target.create(recordInput('batch-1', { category: 'batch' }));
      await target.create(recordInput('batch-2', { category: 'batch' }));
      assertEqual(await operation(target, 'markGroup')({ group: 'batch' }), 2, 'Batch count');
      assertEqual((await target.getById('batch-1'))?.status, 'active', 'Batch first row');
      assertEqual((await target.getById('batch-2'))?.status, 'active', 'Batch second row');
    },
  ),
  defineCase(
    'operation.batch-best-effort',
    'non-atomic batch remains available without claiming an all-record transaction',
    ['crud.create', 'crud.read', 'operation.batch'],
    async harness => {
      const target = adapter(harness);
      await target.create(recordInput('batch-best-effort-1', { category: 'batch-best-effort' }));
      await target.create(recordInput('batch-best-effort-2', { category: 'batch-best-effort' }));
      assertEqual(
        await operation(target, 'markGroupBestEffort')({ group: 'batch-best-effort' }),
        2,
        'Best-effort batch count',
      );
      assertEqual(
        (await target.getById('batch-best-effort-1'))?.status,
        'active',
        'Best-effort batch first row',
      );
    },
  ),
  defineCase(
    'operation.computed-aggregate',
    'computed aggregate materializes a result on its target',
    ['crud.create', 'crud.read', 'operation.computedAggregate', 'atomic.computed-aggregate'],
    async harness => {
      const target = adapter(harness);
      await target.create(recordInput('computed-target', { category: 'computed' }));
      await target.create(recordInput('computed-source', { category: 'computed' }));
      await operation(
        target,
        'materializeGroupCount',
      )({ group: 'computed', id: 'computed-target' });
      assertEqual(
        JSON.stringify((await target.getById('computed-target'))?.metadata),
        JSON.stringify({ total: 2 }),
        'Materialized aggregate',
      );
    },
  ),
  defineCase(
    'operation.computed-aggregate-best-effort',
    'non-atomic computed aggregate remains available without a transaction claim',
    ['crud.create', 'crud.read', 'operation.computedAggregate'],
    async harness => {
      const target = adapter(harness);
      await target.create(
        recordInput('computed-best-effort-target', { category: 'computed-best-effort' }),
      );
      await target.create(
        recordInput('computed-best-effort-source', { category: 'computed-best-effort' }),
      );
      await operation(
        target,
        'materializeGroupCountBestEffort',
      )({ group: 'computed-best-effort', id: 'computed-best-effort-target' });
      assertEqual(
        JSON.stringify((await target.getById('computed-best-effort-target'))?.metadata),
        JSON.stringify({ total: 2 }),
        'Best-effort materialized aggregate',
      );
    },
  ),
] as const;

const COMPOSITION_AND_REGRESSIONS = [
  defineCase(
    'composition.pipe',
    'pipe preserves step ordering and returns the final result',
    ['crud.create', 'operation.lookup', 'operation.pipe'],
    async harness => {
      const target = adapter(harness);
      await target.create(recordInput('pipe-1'));
      const result = (await operation(
        harness.composite(CONFORMANCE_COMPOSITE_KEY),
        'lookupTwice',
      )({ id: 'pipe-1' })) as RecordValue;
      assertEqual(result.id, 'pipe-1', 'Pipe result');
    },
  ),
  defineCase(
    'composition.transaction-commit',
    'transaction commits cross-entity writes together',
    ['crud.create', 'crud.read', 'operation.transaction', 'transaction.rollback'],
    async harness => {
      const composite = harness.composite(CONFORMANCE_COMPOSITE_KEY);
      await operation(
        composite,
        'commitPair',
      )({
        recordId: 'tx-record',
        auditId: 'tx-audit',
        email: 'tx@example.test',
        group: 'tx',
        slug: 'tx',
        title: 'transaction',
        immutableCode: 'tx-code',
        message: 'created',
      });
      assert(await adapter(harness).getById('tx-record'), 'Committed record must exist');
      assert(await adapter(harness, 'audits').getById('tx-audit'), 'Committed audit must exist');
    },
  ),
  defineCase(
    'composition.transaction-rollback',
    'later-step failure rolls back earlier cross-entity writes',
    ['crud.create', 'crud.read', 'operation.transaction', 'transaction.rollback'],
    async harness => {
      const audits = adapter(harness, 'audits');
      await audits.create({ id: 'duplicate-audit', recordId: 'existing', message: 'existing' });
      try {
        await operation(
          harness.composite(CONFORMANCE_COMPOSITE_KEY),
          'rollbackPair',
        )({
          recordId: 'rollback-record',
          auditId: 'duplicate-audit',
          email: 'rollback@example.test',
          group: 'rollback',
          slug: 'rollback',
          title: 'rollback',
          immutableCode: 'rollback-code',
          message: 'must fail',
        });
        throw new Error('Expected transaction failure injection to reject');
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === 'Expected transaction failure injection to reject'
        )
          throw error;
      }
      assertEqual(
        await adapter(harness).getById('rollback-record'),
        null,
        'Rolled-back first write',
      );
    },
  ),
  defineCase(
    'composition.transaction-full-match',
    'transaction matching honors every declared non-primary field',
    ['crud.create', 'crud.read', 'crud.update', 'operation.transaction', 'transaction.rollback'],
    async harness => {
      const target = adapter(harness);
      const composite = harness.composite(CONFORMANCE_COMPOSITE_KEY);
      await target.create(recordInput('tx-match', { status: 'pending' }));

      const updated = (await operation(
        composite,
        'matchAndUpdate',
      )({
        email: 'tx-match@example.test',
        expectedStatus: 'pending',
        title: 'matched',
      })) as RecordValue[];
      assertEqual(updated[0]?.id, 'tx-match', 'Transaction match result');
      assertEqual((await target.getById('tx-match'))?.title, 'matched', 'Matched update');

      let rejected = false;
      try {
        await operation(
          composite,
          'matchAndUpdate',
        )({
          email: 'tx-match@example.test',
          expectedStatus: 'complete',
          title: 'must-not-write',
        });
      } catch {
        rejected = true;
      }
      assert(rejected, 'Mismatched secondary guard must reject');
      assertEqual((await target.getById('tx-match'))?.title, 'matched', 'Guarded row');
    },
  ),
  defineCase(
    'composition.transaction-delete-result',
    'transaction delete preserves the adapter result for a missing match',
    ['crud.delete', 'operation.transaction', 'transaction.rollback'],
    async harness => {
      const results = (await operation(
        harness.composite(CONFORMANCE_COMPOSITE_KEY),
        'deleteByMatch',
      )({
        email: 'missing@example.test',
        expectedStatus: 'pending',
      })) as RecordValue[];
      assertEqual(results[0]?.deleted, false, 'Missing transaction delete result');
    },
  ),
  defineNativeTransactionRollbackCase(
    'composition.transaction-native-field-update',
    'named field update rolls back after a later required miss',
    [
      'crud.create',
      'crud.read',
      'operation.fieldUpdate',
      'operation.transaction',
      'transaction.rollback',
    ],
    'nativeFieldUpdateRollback',
    { status: 'pending' },
    { expectedStatus: 'pending', status: 'review' },
    record => assertEqual(record.status, 'pending', 'Rolled-back field update'),
  ),
  defineNativeTransactionRollbackCase(
    'composition.transaction-native-transition',
    'named transition rolls back after a later required miss',
    [
      'crud.create',
      'crud.read',
      'operation.transition',
      'atomic.transition',
      'operation.transaction',
      'transaction.rollback',
    ],
    'nativeTransitionRollback',
    { status: 'pending' },
    {},
    record => assertEqual(record.status, 'pending', 'Rolled-back transition'),
  ),
  defineNativeTransactionRollbackCase(
    'composition.transaction-native-batch',
    'named batch rolls back after a later required miss',
    [
      'crud.create',
      'crud.read',
      'operation.batch',
      'atomic.batch',
      'operation.transaction',
      'transaction.rollback',
    ],
    'nativeBatchRollback',
    { category: 'native-batch', status: 'pending' },
    { group: 'native-batch' },
    record => assertEqual(record.status, 'pending', 'Rolled-back batch'),
  ),
  defineNativeTransactionRollbackCase(
    'composition.transaction-native-array-push',
    'named array push rolls back after a later required miss',
    [
      'crud.create',
      'crud.read',
      'operation.arrayPush',
      'atomic.array-mutation',
      'operation.transaction',
      'transaction.rollback',
    ],
    'nativeArrayPushRollback',
    { tags: [] },
    { tag: 'added' },
    record => assertArrayEqual(record.tags as unknown[], [], 'Rolled-back array push'),
  ),
  defineNativeTransactionRollbackCase(
    'composition.transaction-native-array-pull',
    'named array pull rolls back after a later required miss',
    [
      'crud.create',
      'crud.read',
      'operation.arrayPull',
      'atomic.array-mutation',
      'operation.transaction',
      'transaction.rollback',
    ],
    'nativeArrayPullRollback',
    { tags: ['existing'] },
    { tag: 'existing' },
    record => assertArrayEqual(record.tags as unknown[], ['existing'], 'Rolled-back array pull'),
  ),
  defineNativeTransactionRollbackCase(
    'composition.transaction-native-increment',
    'named increment rolls back after a later required miss',
    [
      'crud.create',
      'crud.read',
      'operation.increment',
      'atomic.increment',
      'operation.transaction',
      'transaction.rollback',
    ],
    'nativeIncrementRollback',
    { count: 1 },
    {},
    record => assertEqual(record.count, 1, 'Rolled-back increment'),
  ),
  defineCase(
    'scope.two-entity-commit',
    'scoped package work commits two typed entity adapters together',
    ['crud.create', 'crud.read', 'transaction.rollback'],
    async harness => {
      const transactions = harness.transactions;
      assert(transactions, 'Claiming store must expose the scoped transaction harness');
      await transactions.manager.run(transactions.store, async scope => {
        await transactions
          .adapter<RecordValue, RecordValue, RecordValue>(CONFORMANCE_RECORDS_KEY, scope)
          .create(recordInput('scope-commit-record'));
        await transactions.adapter<RecordValue, RecordValue, RecordValue>('audits', scope).create({
          id: 'scope-commit-audit',
          recordId: 'scope-commit-record',
          message: 'committed',
        });
      });
      assert(await adapter(harness).getById('scope-commit-record'), 'Committed record must exist');
      assert(
        await adapter(harness, 'audits').getById('scope-commit-audit'),
        'Committed audit must exist',
      );
    },
  ),
  defineCase(
    'scope.two-entity-rollback',
    'scoped package work rolls back two typed entity adapters together',
    ['crud.create', 'crud.read', 'transaction.rollback'],
    async harness => {
      const transactions = harness.transactions;
      assert(transactions, 'Claiming store must expose the scoped transaction harness');
      try {
        await transactions.manager.run(transactions.store, async scope => {
          await transactions
            .adapter<RecordValue, RecordValue, RecordValue>(CONFORMANCE_RECORDS_KEY, scope)
            .create(recordInput('scope-rollback-record'));
          await transactions
            .adapter<RecordValue, RecordValue, RecordValue>('audits', scope)
            .create({
              id: 'scope-rollback-audit',
              recordId: 'scope-rollback-record',
              message: 'rollback',
            });
          throw new Error('injected scoped rollback');
        });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'injected scoped rollback') throw error;
      }
      assertEqual(
        await adapter(harness).getById('scope-rollback-record'),
        null,
        'Rolled-back scoped record',
      );
      assertEqual(
        await adapter(harness, 'audits').getById('scope-rollback-audit'),
        null,
        'Rolled-back scoped audit',
      );
    },
  ),
  defineCase(
    'scope.same-store-nesting',
    'same-store nested manager calls reuse the exact scope',
    ['transaction.rollback'],
    async harness => {
      const transactions = harness.transactions;
      assert(transactions, 'Claiming store must expose the scoped transaction harness');
      await transactions.manager.run(transactions.store, async scope => {
        await transactions.manager.run(transactions.store, nestedScope => {
          assertEqual(nestedScope, scope, 'Nested transaction scope identity');
        });
      });
    },
  ),
  defineCase(
    'scope.cross-store-rejection',
    'cross-store nesting rejects before opening independent work',
    ['transaction.rollback'],
    async harness => {
      const transactions = harness.transactions;
      assert(transactions, 'Claiming store must expose the scoped transaction harness');
      const otherStore = {
        sqlite: 'postgres',
        postgres: 'sqlite',
        mongo: 'sqlite',
      } as const;
      let rejected = false;
      await transactions.manager.run(transactions.store, async () => {
        try {
          await transactions.manager.run(otherStore[transactions.store], async () => undefined);
        } catch {
          rejected = true;
        }
      });
      assert(rejected, 'Cross-store nested transaction must reject');
    },
  ),
  defineCase(
    'scope.closed-adapter-rejection',
    'a retained scoped adapter rejects after its callback closes',
    ['crud.read', 'transaction.rollback'],
    async harness => {
      const transactions = harness.transactions;
      assert(transactions, 'Claiming store must expose the scoped transaction harness');
      let retained: Adapter | undefined;
      await transactions.manager.run(transactions.store, scope => {
        retained = transactions.adapter<RecordValue, RecordValue, RecordValue>(
          CONFORMANCE_RECORDS_KEY,
          scope,
        );
      });
      assert(retained, 'Scoped adapter must be retained for the lifecycle assertion');
      let rejected = false;
      try {
        await retained.getById('closed-scope');
      } catch {
        rejected = true;
      }
      assert(rejected, 'Closed scoped adapter must reject');
    },
  ),
  defineCase(
    'composition.missing-rejection',
    'missing adapter and composite lookups reject deterministically',
    ['crud.read'],
    async harness => {
      let adapterRejected = false;
      let compositeRejected = false;
      try {
        harness.adapter('missing');
      } catch {
        adapterRejected = true;
      }
      try {
        harness.composite('missing');
      } catch {
        compositeRejected = true;
      }
      assert(adapterRejected && compositeRejected, 'Missing harness targets must reject');
    },
  ),
  defineCase(
    'regression.guard-changing-update',
    'guarded update returns the row after changing its own guard',
    ['crud.create', 'operation.fieldUpdate'],
    async harness => {
      const target = adapter(harness);
      await target.create(recordInput('guard-1'));
      const result = (await operation(target, 'guardedStatusUpdate')(
        { id: 'guard-1', expectedStatus: 'pending' },
        { status: 'complete' },
      )) as RecordValue;
      assertEqual(result.id, 'guard-1', 'Guard-changing update row');
      assertEqual(result.status, 'complete', 'Guard-changing update status');
    },
  ),
  defineCase(
    'regression.failed-delete',
    'failed delete reports false',
    ['crud.delete'],
    async harness => {
      assertEqual(await adapter(harness).delete('missing-delete'), false, 'Failed delete result');
    },
  ),
] as const;

const RACES = [
  defineCase(
    'race.duplicate-create',
    '25 concurrent duplicate creates persist exactly one row',
    ['crud.create', 'crud.read'],
    async harness => {
      const target = adapter(harness);
      const outcomes = await Promise.allSettled(
        Array.from({ length: 25 }, (_, index) =>
          target.create(recordInput('race-create', { title: `candidate-${index}` })),
        ),
      );
      assertEqual(
        outcomes.filter(result => result.status === 'fulfilled').length,
        1,
        'Successful duplicate creates',
      );
      assertEqual(
        outcomes.filter(result => result.status === 'rejected').length,
        24,
        'Rejected duplicate creates',
      );
      assert(await target.getById('race-create'), 'Race winner must persist');
    },
  ),
  defineCase(
    'race.competing-transition',
    '25 competing transitions produce exactly one winner',
    ['crud.create', 'crud.read', 'operation.transition', 'atomic.transition'],
    async harness => {
      const target = adapter(harness);
      await target.create(recordInput('race-transition'));
      const outcomes = await Promise.all(
        Array.from({ length: 25 }, () => operation(target, 'activate')({ id: 'race-transition' })),
      );
      assertEqual(outcomes.filter(Boolean).length, 1, 'Transition winners');
      assertEqual(
        (await target.getById('race-transition'))?.status,
        'active',
        'Final transition state',
      );
    },
  ),
  defineCase(
    'race.concurrent-increment',
    '25 concurrent increments persist the exact final value',
    ['crud.create', 'crud.read', 'operation.increment', 'atomic.increment'],
    async harness => {
      const target = adapter(harness);
      await target.create(recordInput('race-increment'));
      await Promise.all(
        Array.from({ length: 25 }, () => operation(target, 'incrementCount')('race-increment', 1)),
      );
      assertEqual((await target.getById('race-increment'))?.count, 25, 'Final increment value');
    },
  ),
  defineCase(
    'race.deduplicated-array-push',
    '25 concurrent deduplicated pushes persist one value',
    ['crud.create', 'crud.read', 'operation.arrayPush', 'atomic.array-mutation'],
    async harness => {
      const target = adapter(harness);
      await target.create(recordInput('race-array'));
      await Promise.all(
        Array.from({ length: 25 }, () => operation(target, 'pushTag')('race-array', 'same')),
      );
      assertArrayEqual(
        (await target.getById('race-array'))?.tags as unknown[],
        ['same'],
        'Final deduplicated array',
      );
    },
  ),
  defineCase(
    'race.consume-once',
    '25 concurrent consumes return one record exactly once',
    ['crud.create', 'operation.consume', 'atomic.consume'],
    async harness => {
      const target = adapter(harness);
      await target.create(recordInput('race-consume'));
      const outcomes = await Promise.all(
        Array.from({ length: 25 }, () => operation(target, 'consumeById')({ id: 'race-consume' })),
      );
      assertEqual(outcomes.filter(Boolean).length, 1, 'Consume winners');
    },
  ),
  defineCase(
    'race.cursor-insert',
    'insertion during cursor traversal does not duplicate or lose original rows',
    ['crud.create', 'crud.list', 'query.sort', 'query.cursor'],
    async harness => {
      const target = adapter(harness);
      const original = Array.from(
        { length: 25 },
        (_, index) => `race-cursor-${String(index).padStart(2, '0')}`,
      );
      for (const id of original) await target.create(recordInput(id, { category: 'race-cursor' }));
      const first = await target.list({ limit: 5 });
      await target.create(recordInput('race-cursor-new', { category: 'race-cursor' }));
      const seen = first.items.map(item => item.id);
      let cursor = first.nextCursor;
      while (cursor) {
        const page = await target.list({ limit: 5, cursor });
        seen.push(...page.items.map(item => item.id));
        cursor = page.nextCursor;
      }
      for (const id of original) {
        assertEqual(seen.filter(value => value === id).length, 1, `Cursor cardinality for ${id}`);
      }
    },
  ),
] as const;

const VERSION_CONCURRENCY = [
  defineCase(
    'concurrency.version-update',
    'version initializes at one, guarded updates increment, and stale writers conflict',
    ['crud.create', 'crud.read', 'crud.update', 'concurrency.version-update'],
    async harness => {
      const target = adapter(harness, CONFORMANCE_VERSIONED_KEY);
      const created = await target.create({
        id: 'version-update',
        tenantId: 'alpha',
        title: 'initial',
      });
      assertEqual(created.version, 1, 'Initial version');
      const updated = await target.update(
        'version-update',
        { title: 'winner' },
        { tenantId: 'alpha' },
        { expectedVersion: 1 },
      );
      assertEqual(updated?.version, 2, 'Updated version');
      await expectErrorCode(
        target.update(
          'version-update',
          { title: 'stale' },
          { tenantId: 'alpha' },
          { expectedVersion: 1 },
        ),
        'ENTITY_CONCURRENCY_CONFLICT',
      );
      assertEqual((await target.getById('version-update'))?.title, 'winner', 'Winning update');
    },
  ),
  defineCase(
    'concurrency.version-precondition',
    'required writes reject missing and invalid expected versions before mutation',
    ['crud.create', 'crud.read', 'crud.update', 'concurrency.version-update'],
    async harness => {
      const target = adapter(harness, CONFORMANCE_VERSIONED_KEY);
      await target.create({ id: 'version-required', tenantId: 'alpha', title: 'initial' });
      await expectErrorCode(
        target.update('version-required', { title: 'missing' }),
        'ENTITY_CONCURRENCY_PRECONDITION_REQUIRED',
      );
      for (const expectedVersion of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        await expectErrorCode(
          target.update('version-required', { title: 'invalid' }, undefined, { expectedVersion }),
          'ENTITY_CONCURRENCY_EXPECTED_VERSION_INVALID',
        );
      }
      assertEqual((await target.getById('version-required'))?.title, 'initial', 'Unchanged record');
    },
  ),
  defineCase(
    'concurrency.version-update-race',
    'two same-version updates produce exactly one success and one typed conflict',
    ['crud.create', 'crud.read', 'crud.update', 'concurrency.version-update'],
    async harness => {
      const target = adapter(harness, CONFORMANCE_VERSIONED_KEY);
      await target.create({ id: 'version-race', tenantId: 'alpha', title: 'initial' });
      const outcomes = await Promise.allSettled([
        target.update('version-race', { title: 'one' }, undefined, { expectedVersion: 1 }),
        target.update('version-race', { title: 'two' }, undefined, { expectedVersion: 1 }),
      ]);
      assertEqual(
        outcomes.filter(outcome => outcome.status === 'fulfilled').length,
        1,
        'Race winners',
      );
      const rejected = outcomes.find(outcome => outcome.status === 'rejected');
      assert(rejected?.status === 'rejected', 'Race must have one rejection');
      assertEqual(
        Reflect.get(rejected.reason as object, 'code'),
        'ENTITY_CONCURRENCY_CONFLICT',
        'Race conflict code',
      );
      assertEqual((await target.getById('version-race'))?.version, 2, 'Race final version');
    },
  ),
  defineCase(
    'concurrency.version-optional-guard',
    'an omitted optional guard writes atomically and still increments the version',
    ['crud.create', 'crud.update', 'concurrency.version-update'],
    async harness => {
      const target = adapter(harness, CONFORMANCE_VERSIONED_OPTIONAL_KEY);
      await target.create({ id: 'version-optional', title: 'initial' });
      const updated = await target.update('version-optional', { title: 'unguarded' });
      assertEqual(updated?.version, 2, 'Optional-guard increment');
      await expectErrorCode(
        target.update('version-optional', { title: 'stale' }, undefined, { expectedVersion: 1 }),
        'ENTITY_CONCURRENCY_CONFLICT',
      );
    },
  ),
  defineCase(
    'concurrency.version-delete',
    'guarded hard delete succeeds once and a stale delete conflicts',
    ['crud.create', 'crud.delete', 'concurrency.version-delete'],
    async harness => {
      const target = adapter(harness, CONFORMANCE_VERSIONED_KEY);
      await target.create({ id: 'delete-stale', tenantId: 'alpha', title: 'initial' });
      await expectErrorCode(
        target.delete('delete-stale', undefined, { expectedVersion: 2 }),
        'ENTITY_CONCURRENCY_CONFLICT',
      );
      assertEqual(
        await target.delete('delete-stale', undefined, { expectedVersion: 1 }),
        true,
        'Guarded delete',
      );
    },
  ),
  defineCase(
    'concurrency.version-scope',
    'tenant-scoped misses remain not-found and do not reveal another tenant version',
    [
      'crud.create',
      'crud.update',
      'crud.delete',
      'scope.tenant',
      'concurrency.version-update',
      'concurrency.version-delete',
    ],
    async harness => {
      const target = adapter(harness, CONFORMANCE_VERSIONED_KEY);
      await target.create({ id: 'version-scope', tenantId: 'alpha', title: 'private' });
      assertEqual(
        await target.update(
          'version-scope',
          { title: 'leak' },
          { tenantId: 'beta' },
          { expectedVersion: 999 },
        ),
        null,
        'Scoped update miss',
      );
      assertEqual(
        await target.delete('version-scope', { tenantId: 'beta' }, { expectedVersion: 999 }),
        false,
        'Scoped delete miss',
      );
    },
  ),
  defineCase(
    'concurrency.version-soft-delete',
    'soft delete is guarded and hides the incremented record',
    [
      'crud.create',
      'crud.read',
      'crud.delete',
      'lifecycle.soft-delete',
      'concurrency.version-delete',
    ],
    async harness => {
      const target = adapter(harness, CONFORMANCE_VERSIONED_SOFT_DELETE_KEY);
      await target.create({ id: 'version-soft', title: 'visible' });
      await expectErrorCode(
        target.delete('version-soft', undefined, { expectedVersion: 2 }),
        'ENTITY_CONCURRENCY_CONFLICT',
      );
      assertEqual(
        await target.delete('version-soft', undefined, { expectedVersion: 1 }),
        true,
        'Soft delete',
      );
      assertEqual(await target.getById('version-soft'), null, 'Soft-deleted visibility');
    },
  ),
] as const;

/** Complete, deeply frozen, backend-independent entity conformance catalog. */
export const ENTITY_CONFORMANCE_CATALOG: readonly EntityConformanceCase[] = deepFreeze([
  ...CRUD,
  ...MAPPING_AND_CONSTRAINTS,
  ...SCOPE_AND_LIFECYCLE,
  ...QUERY,
  ...NAMED_OPERATIONS,
  ...COMPOSITION_AND_REGRESSIONS,
  ...RACES,
  ...VERSION_CONCURRENCY,
]);
