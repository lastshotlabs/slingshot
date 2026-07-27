import {
  type OperationConfig,
  type PipeOpConfig,
  type TransactionOpConfig,
  deepFreeze,
  defineEntity,
  field,
  index,
} from '@lastshotlabs/slingshot-core';
import type { EntityConformanceDefinition } from './conformance';

export const CONFORMANCE_RECORDS_KEY = 'records';
export const CONFORMANCE_TENANTS_KEY = 'tenants';
export const CONFORMANCE_SOFT_DELETE_KEY = 'softDelete';
export const CONFORMANCE_TTL_KEY = 'ttl';
export const CONFORMANCE_COMPOSITE_KEY = 'workflow';

const Records = defineEntity('ConformanceRecord', {
  namespace: 'entity_conformance',
  fields: {
    id: field.string({ primary: true }),
    email: field.string(),
    category: field.string(),
    slug: field.string(),
    title: field.string(),
    status: field.string({ default: 'pending' }),
    count: field.integer({ default: 0 }),
    score: field.number({ default: 0 }),
    active: field.boolean({ default: true }),
    occurredAt: field.date({ default: 'now' }),
    metadata: field.json({ optional: true }),
    tags: field.stringArray({ optional: true }),
    immutableCode: field.string({ immutable: true }),
    nullableNote: field.string({ optional: true }),
    updatedAt: field.date({ default: 'now', onUpdate: 'now' }),
  },
  uniques: [{ fields: ['email'] }],
  indexes: [index(['category', 'slug'], { unique: true })],
  pagination: {
    cursor: { fields: ['category', 'id'] },
    defaultLimit: 2,
    maxLimit: 50,
  },
  defaultSort: { field: 'category', direction: 'asc' },
});

const Tenants = defineEntity('ConformanceTenant', {
  namespace: 'entity_conformance',
  fields: {
    id: field.string({ primary: true }),
    tenantId: field.string(),
    title: field.string(),
  },
  tenant: { field: 'tenantId' },
});

const SoftDelete = defineEntity('ConformanceSoftDelete', {
  namespace: 'entity_conformance',
  fields: {
    id: field.string({ primary: true }),
    title: field.string(),
    deletedAt: field.date({ optional: true }),
  },
  softDelete: { field: 'deletedAt', strategy: 'non-null' },
});

const Ttl = defineEntity('ConformanceTtl', {
  namespace: 'entity_conformance',
  fields: {
    id: field.string({ primary: true }),
    title: field.string(),
  },
  ttl: { defaultSeconds: 0.02 },
});

const Audit = defineEntity('ConformanceAudit', {
  namespace: 'entity_conformance',
  fields: {
    id: field.string({ primary: true }),
    recordId: field.string(),
    message: field.string(),
  },
});

const RECORD_OPERATIONS = deepFreeze({
  lookupOne: {
    kind: 'lookup',
    fields: { id: 'param:id' },
    returns: 'one',
  },
  lookupMany: {
    kind: 'lookup',
    fields: { category: 'param:group' },
    returns: 'many',
  },
  existsByEmail: {
    kind: 'exists',
    fields: { email: 'param:email' },
  },
  activate: {
    kind: 'transition',
    field: 'status',
    from: 'pending',
    to: 'active',
    match: { id: 'param:id' },
  },
  guardedStatusUpdate: {
    kind: 'fieldUpdate',
    match: { id: 'param:id', status: 'param:expectedStatus' },
    set: ['status'],
  },
  totals: {
    kind: 'aggregate',
    compute: {
      total: { count: true },
      score: { sum: 'score' },
    },
  },
  materializeGroupCount: {
    kind: 'computedAggregate',
    source: Records._storageName,
    target: Records._storageName,
    sourceFilter: { category: 'param:group' },
    compute: { total: { count: true } },
    materializeTo: 'metadata',
    targetMatch: { id: 'param:id' },
    atomic: true,
  },
  markGroup: {
    kind: 'batch',
    action: 'update',
    filter: { category: 'param:group' },
    set: { status: 'active' },
    atomic: true,
    returns: 'count',
  },
  upsertByEmail: {
    kind: 'upsert',
    match: ['email'],
    set: ['title', 'category', 'slug', 'immutableCode'],
    onCreate: { id: 'uuid' },
    returns: { entity: true, created: true },
  },
  searchTitles: {
    kind: 'search',
    fields: ['title'],
    paginate: true,
    useSearchProvider: false,
  },
  comments: {
    kind: 'collection',
    parentKey: 'recordId',
    itemFields: {
      id: field.string(),
      body: field.string(),
    },
    operations: ['list', 'add', 'remove', 'update', 'set'],
    identifyBy: 'id',
  },
  consumeById: {
    kind: 'consume',
    filter: { id: 'param:id' },
    returns: 'entity',
  },
  deriveTitles: {
    kind: 'derive',
    sources: [
      {
        from: Records._storageName,
        where: { category: 'param:group' },
        select: 'title',
      },
    ],
    merge: 'concat',
  },
  ping: {
    kind: 'custom',
    memory: () => async () => 'pong',
    sqlite: () => async () => 'pong',
  },
  pushTag: {
    kind: 'arrayPush',
    field: 'tags',
    value: 'input:tag',
    dedupe: true,
  },
  pullTag: {
    kind: 'arrayPull',
    field: 'tags',
    value: 'input:tag',
  },
  setTags: {
    kind: 'arraySet',
    field: 'tags',
    value: 'input:tags',
    dedupe: true,
  },
  incrementCount: {
    kind: 'increment',
    field: 'count',
  },
} satisfies Record<string, OperationConfig>);

export const CONFORMANCE_COMPOSITE_OPERATIONS = deepFreeze({
  lookupTwice: {
    kind: 'pipe',
    steps: [
      {
        op: 'lookupOne',
        config: RECORD_OPERATIONS.lookupOne,
      },
      {
        op: 'lookupOne',
        config: RECORD_OPERATIONS.lookupOne,
        input: { id: 'result:id' },
      },
    ],
  },
  commitPair: {
    kind: 'transaction',
    steps: [
      {
        op: 'create',
        entity: CONFORMANCE_RECORDS_KEY,
        input: {
          id: 'param:recordId',
          email: 'param:email',
          category: 'param:group',
          slug: 'param:slug',
          title: 'param:title',
          immutableCode: 'param:immutableCode',
        },
      },
      {
        op: 'create',
        entity: 'audits',
        input: {
          id: 'param:auditId',
          recordId: 'result:0.id',
          message: 'param:message',
        },
      },
    ],
  },
  rollbackPair: {
    kind: 'transaction',
    steps: [
      {
        op: 'create',
        entity: CONFORMANCE_RECORDS_KEY,
        input: {
          id: 'param:recordId',
          email: 'param:email',
          category: 'param:group',
          slug: 'param:slug',
          title: 'param:title',
          immutableCode: 'param:immutableCode',
        },
      },
      {
        op: 'create',
        entity: 'audits',
        input: {
          id: 'param:auditId',
          recordId: 'result:0.id',
          message: 'param:message',
        },
      },
    ],
  },
} satisfies Record<string, PipeOpConfig | TransactionOpConfig>);

/** Canonical resolved fixtures installed by every conformance driver. */
export const ENTITY_CONFORMANCE_DEFINITIONS = deepFreeze([
  {
    key: CONFORMANCE_RECORDS_KEY,
    config: Records,
    operations: RECORD_OPERATIONS,
  },
  { key: CONFORMANCE_TENANTS_KEY, config: Tenants },
  { key: CONFORMANCE_SOFT_DELETE_KEY, config: SoftDelete },
  { key: CONFORMANCE_TTL_KEY, config: Ttl },
  { key: 'audits', config: Audit },
] satisfies readonly EntityConformanceDefinition[]);
