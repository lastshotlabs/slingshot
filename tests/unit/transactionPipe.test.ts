import { beforeEach, describe, expect, it } from 'bun:test';
import {
  EntityTransactionConflictError,
  TransactionBindingError,
} from '@lastshotlabs/slingshot-core';
import { createEntityFactories, defineOperations, op } from '@lastshotlabs/slingshot-entity';
import type { EntityAdapter } from '../../packages/slingshot-core/src/entityConfig';
import { defineEntity, field } from '../../packages/slingshot-core/src/entityConfig';
import { pipeExecutor } from '../../packages/slingshot-entity/src/configDriven/operationExecutors/pipe';
import { transactionExecutor } from '../../packages/slingshot-entity/src/configDriven/operationExecutors/transaction';

// ---------------------------------------------------------------------------
// Test entities
// ---------------------------------------------------------------------------

const Room = defineEntity('Room', {
  namespace: 'test',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    name: field.string(),
    lastMessageAt: field.date({ optional: true }),
    messageCount: field.integer({ default: 0 }),
  },
});

const Message = defineEntity('Message', {
  namespace: 'test',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    roomId: field.string(),
    content: field.string(),
    status: field.enum(['sent', 'delivered', 'read'], { default: 'sent' }),
    createdAt: field.date({ default: 'now' }),
  },
});

// Entity for array mutation and lookup step tests
const Document = defineEntity('Document', {
  namespace: 'test',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    title: field.string(),
    body: field.string({ optional: true }),
    outwardLinks: field.json({ optional: true }),
    inwardLinks: field.json({ optional: true }),
  },
});

const Snapshot = defineEntity('Snapshot', {
  namespace: 'test',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    documentId: field.string(),
    title: field.string(),
    body: field.string({ optional: true }),
    type: field.string({ optional: true }),
  },
});

const MessageOps = defineOperations(Message, {
  getByRoom: op.lookup({ fields: { roomId: 'param:roomId' }, returns: 'many' }),
  markDelivered: op.transition({
    field: 'status',
    from: 'sent',
    to: 'delivered',
    match: { id: 'param:id' },
  }),
});

const DocumentOps = defineOperations(Document, {
  pushOutward: op.arrayPush({ field: 'outwardLinks', value: 'input:value' }),
  pushInward: op.arrayPush({ field: 'inwardLinks', value: 'input:value' }),
  pullOutward: op.arrayPull({ field: 'outwardLinks', value: 'input:value' }),
});

// Type aliases derived from the concrete entity factories.
// Using module-level factory instances lets ReturnType infer the concrete adapter types.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _roomFactories = createEntityFactories(Room);
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _messageFactories = createEntityFactories(Message, MessageOps.operations);
type RoomAdapter = ReturnType<typeof _roomFactories.memory>;
type MessageAdapter = ReturnType<typeof _messageFactories.memory>;

// ---------------------------------------------------------------------------
// op.transaction tests
// ---------------------------------------------------------------------------

describe('op.transaction', () => {
  let roomAdapter: RoomAdapter;
  let messageAdapter: MessageAdapter;

  beforeEach(async () => {
    roomAdapter = createEntityFactories(Room).memory() as unknown as RoomAdapter;
    messageAdapter = createEntityFactories(
      Message,
      MessageOps.operations,
    ).memory() as unknown as MessageAdapter;
    await roomAdapter.clear();
    await messageAdapter.clear();
  });

  it('executes multiple steps across entities', async () => {
    // Create a room first — cast to bypass InferCreateInput literal-widening in root tsconfig
    const room = await (
      roomAdapter as unknown as EntityAdapter<
        Record<string, unknown>,
        Record<string, unknown>,
        Record<string, unknown>
      >
    ).create({ name: 'General' });

    const txn = transactionExecutor(
      {
        kind: 'transaction',
        steps: [
          {
            op: 'create',
            entity: 'messages',
            input: { roomId: 'param:roomId', content: 'param:content' },
          },
          {
            op: 'update',
            entity: 'rooms',
            match: { id: 'param:roomId' },
            set: { messageCount: 'param:newCount' },
          },
        ],
      },
      {
        messages: messageAdapter,
        rooms: roomAdapter,
      } as unknown as Parameters<typeof transactionExecutor>[1],
    );

    const results = await txn({ roomId: room.id, content: 'Hello!', newCount: 1 });
    expect(results.length).toBe(2);

    // Message created
    expect((results[0] as Record<string, unknown>).content).toBe('Hello!');
    expect((results[0] as Record<string, unknown>).id).toBeDefined();

    // Room updated
    expect((results[1] as Record<string, unknown>).messageCount).toBe(1);

    // Verify persistence
    const messages = await (
      messageAdapter as unknown as EntityAdapter<
        Record<string, unknown>,
        Record<string, unknown>,
        Record<string, unknown>
      >
    ).list();
    expect(messages.items.length).toBe(1);

    const updatedRoom = await (
      roomAdapter as unknown as EntityAdapter<
        Record<string, unknown>,
        Record<string, unknown>,
        Record<string, unknown>
      >
    ).getById(room.id as string);
    expect(updatedRoom!.messageCount).toBe(1);
  });

  it('supports result references between steps', async () => {
    const room = await (
      roomAdapter as unknown as EntityAdapter<
        Record<string, unknown>,
        Record<string, unknown>,
        Record<string, unknown>
      >
    ).create({ name: 'General' });

    const txn = transactionExecutor(
      {
        kind: 'transaction',
        steps: [
          {
            op: 'create',
            entity: 'messages',
            input: { roomId: 'param:roomId', content: 'Hello!' },
          },
          {
            op: 'create',
            entity: 'messages',
            input: { roomId: 'param:roomId', content: 'result:0.id' }, // reference first step's id
          },
        ],
      },
      {
        messages: messageAdapter,
        rooms: roomAdapter,
      } as unknown as Parameters<typeof transactionExecutor>[1],
    );

    const results = await txn({ roomId: room.id });
    expect((results[1] as Record<string, unknown>).content).toBe(
      (results[0] as Record<string, unknown>).id,
    ); // second message's content = first message's id
  });

  it('dispatches the exact named transition and normalizes a guard miss to HTTP 409', async () => {
    const entityAdapter = messageAdapter as unknown as EntityAdapter<
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>
    >;
    const message = await entityAdapter.create({ roomId: 'room-1', content: 'Hello!' });
    (messageAdapter as unknown as Record<string, unknown>).update = async () => {
      throw new Error('generic update must not be called');
    };

    const txn = transactionExecutor(
      {
        kind: 'transaction',
        steps: [
          {
            op: 'transition',
            entity: 'messages',
            operation: 'markDelivered',
            input: { id: 'param:messageId' },
          },
        ],
      },
      { messages: messageAdapter } as unknown as Parameters<typeof transactionExecutor>[1],
      {
        operationName: 'deliver',
        operationConfigs: { messages: MessageOps.operations },
      },
    );

    const results = await txn({ messageId: message.id });
    expect((results[0] as Record<string, unknown>).status).toBe('delivered');
    await expect(txn({ messageId: message.id })).rejects.toMatchObject({
      status: 409,
      code: 'ENTITY_TRANSACTION_CONFLICT',
      entity: 'messages',
      operation: 'markDelivered',
      stepIndex: 0,
    } satisfies Partial<EntityTransactionConflictError>);
  });

  it('resolves nested bindings and reports missing params with operation metadata', async () => {
    const adapter = {
      create: async (input: Record<string, unknown>) => input,
      getById: async () => null,
      update: async () => null,
      delete: async () => false,
      list: async () => ({ items: [], hasMore: false }),
      clear: async () => {},
    };
    const txn = transactionExecutor(
      {
        kind: 'transaction',
        steps: [
          {
            op: 'create',
            entity: 'records',
            input: { nested: { values: ['param:value'] } },
          },
        ],
      },
      { records: adapter },
      { operationName: 'nestedWrite' },
    );

    expect(await txn({ value: 'resolved' })).toEqual([{ nested: { values: ['resolved'] } }]);
    await expect(txn({})).rejects.toMatchObject({
      code: 'TRANSACTION_BINDING_INVALID',
      operationName: 'nestedWrite',
      stepIndex: 0,
    } satisfies Partial<TransactionBindingError>);
  });

  it('routes every semantic step family through its exact configured method', async () => {
    const calls: Array<{ name: string; args: unknown[] }> = [];
    const record =
      (name: string, result: unknown) =>
      async (...args: unknown[]): Promise<unknown> => {
        calls.push({ name, args });
        return result;
      };
    const forbidden = async (): Promise<never> => {
      throw new Error('generic CRUD must not implement a semantic step');
    };
    const adapter = {
      create: forbidden,
      getById: forbidden,
      update: forbidden,
      delete: forbidden,
      list: forbidden,
      clear: async () => {},
      setFields: record('setFields', { id: 'r1', value: 'set' }),
      advance: record('advance', true),
      purge: record('purge', 2),
      attach: record('attach', { id: 'r1', values: ['v1'] }),
      detach: record('detach', { id: 'r1', values: [] }),
      add: record('add', { id: 'r1', count: 3 }),
    };
    const txn = transactionExecutor(
      {
        kind: 'transaction',
        steps: [
          {
            op: 'fieldUpdate',
            entity: 'records',
            operation: 'setFields',
            input: { id: 'param:id', value: 'param:value' },
          },
          {
            op: 'transition',
            entity: 'records',
            operation: 'advance',
            input: { id: 'param:id' },
          },
          { op: 'batch', entity: 'records', operation: 'purge', input: { owner: 'param:id' } },
          {
            op: 'arrayPush',
            entity: 'records',
            operation: 'attach',
            input: { id: 'param:id', value: 'param:value' },
          },
          {
            op: 'arrayPull',
            entity: 'records',
            operation: 'detach',
            input: { id: 'param:id', value: 'param:value' },
          },
          {
            op: 'increment',
            entity: 'records',
            operation: 'add',
            input: { id: 'param:id', by: 3 },
          },
        ],
      },
      { records: adapter } as unknown as Parameters<typeof transactionExecutor>[1],
    );

    const results = await txn({ id: 'r1', value: 'v1' });
    expect(calls.map(call => call.name)).toEqual([
      'setFields',
      'advance',
      'purge',
      'attach',
      'detach',
      'add',
    ]);
    expect(calls[0]?.args).toEqual([
      { id: 'r1', value: 'v1' },
      { id: 'r1', value: 'v1' },
    ]);
    expect(calls[3]?.args).toEqual(['r1', 'v1']);
    expect(calls[5]?.args).toEqual(['r1', 3]);
    expect(results[1]).toEqual({ applied: true });
    expect(results[2]).toEqual({ count: 2 });
  });

  it('throws when entity not found in adapters', async () => {
    const txn = transactionExecutor(
      {
        kind: 'transaction',
        steps: [{ op: 'create', entity: 'nonexistent', input: {} }],
      },
      { messages: messageAdapter } as unknown as Parameters<typeof transactionExecutor>[1],
    );

    expect(txn({})).rejects.toThrow("Entity 'nonexistent' not found");
  });
});

// ---------------------------------------------------------------------------
// op.pipe tests
// ---------------------------------------------------------------------------

describe('op.pipe', () => {
  let adapter: MessageAdapter;

  beforeEach(async () => {
    adapter = createEntityFactories(
      Message,
      MessageOps.operations,
    ).memory() as unknown as MessageAdapter;
    await adapter.clear();
  });

  it('chains operations passing results forward', async () => {
    // Create some messages — cast to bypass InferCreateInput literal-widening in root tsconfig
    const ea = adapter as unknown as EntityAdapter<
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>
    >;
    await ea.create({ roomId: 'r1', content: 'hello' });
    await ea.create({ roomId: 'r1', content: 'world' });

    const pipe = pipeExecutor(
      {
        kind: 'pipe',
        steps: [
          {
            op: 'getByRoom',
            config: { kind: 'lookup', fields: { roomId: 'param:roomId' }, returns: 'many' },
          },
        ],
      },
      adapter as unknown as Parameters<typeof pipeExecutor>[1],
    );

    const result = (await pipe({ roomId: 'r1' })) as Record<string, unknown>;
    expect((result as { items: unknown[] }).items.length).toBe(2);
  });

  it('throws when operation not found on adapter', async () => {
    const pipe = pipeExecutor(
      {
        kind: 'pipe',
        steps: [{ op: 'nonexistent', config: { kind: 'lookup', fields: {}, returns: 'one' } }],
      },
      adapter as unknown as Parameters<typeof pipeExecutor>[1],
    );

    expect(pipe({})).rejects.toThrow("Operation 'nonexistent' not found");
  });
});

// ---------------------------------------------------------------------------
// op.transaction — arrayPush / arrayPull steps
// ---------------------------------------------------------------------------

describe('op.transaction — arrayPush and arrayPull steps', () => {
  const docFactories = createEntityFactories(Document, DocumentOps.operations);
  type DocAdapter = ReturnType<typeof docFactories.memory>;
  let docAdapter: DocAdapter;

  beforeEach(async () => {
    docAdapter = docFactories.memory();
    await docAdapter.clear();
  });

  it('arrayPush step appends a value to an array field', async () => {
    const ea = docAdapter as unknown as EntityAdapter<
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>
    >;
    const doc = await ea.create({ title: 'A', outwardLinks: [] });

    const txn = transactionExecutor(
      {
        kind: 'transaction',
        steps: [
          {
            op: 'arrayPush',
            entity: 'documents',
            operation: 'pushOutward',
            input: { id: 'param:id', value: 'param:targetId' },
          },
        ],
      },
      { documents: docAdapter } as unknown as Parameters<typeof transactionExecutor>[1],
    );

    const results = await txn({ id: doc.id, targetId: 'doc-b' });
    expect((results[0] as Record<string, unknown>).outwardLinks).toEqual(['doc-b']);
  });

  it('arrayPush step deduplicates by default', async () => {
    const ea = docAdapter as unknown as EntityAdapter<
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>
    >;
    const doc = await ea.create({ title: 'A', outwardLinks: ['doc-b'] });

    const txn = transactionExecutor(
      {
        kind: 'transaction',
        steps: [
          {
            op: 'arrayPush',
            entity: 'documents',
            operation: 'pushOutward',
            input: { id: 'param:id', value: 'param:targetId' },
          },
        ],
      },
      { documents: docAdapter } as unknown as Parameters<typeof transactionExecutor>[1],
    );

    const results = await txn({ id: doc.id, targetId: 'doc-b' });
    // Should not duplicate
    expect((results[0] as Record<string, unknown>).outwardLinks).toEqual(['doc-b']);
  });

  it('arrayPull step removes a value from an array field', async () => {
    const ea = docAdapter as unknown as EntityAdapter<
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>
    >;
    const doc = await ea.create({ title: 'A', outwardLinks: ['doc-b', 'doc-c'] });

    const txn = transactionExecutor(
      {
        kind: 'transaction',
        steps: [
          {
            op: 'arrayPull',
            entity: 'documents',
            operation: 'pullOutward',
            input: { id: 'param:id', value: 'param:targetId' },
          },
        ],
      },
      { documents: docAdapter } as unknown as Parameters<typeof transactionExecutor>[1],
    );

    const results = await txn({ id: doc.id, targetId: 'doc-b' });
    expect((results[0] as Record<string, unknown>).outwardLinks).toEqual(['doc-c']);
  });

  it('bidirectional arrayPush — mirrors push across two records of the same entity', async () => {
    const ea = docAdapter as unknown as EntityAdapter<
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>
    >;
    const docA = await ea.create({ title: 'A', outwardLinks: [], inwardLinks: [] });
    const docB = await ea.create({ title: 'B', outwardLinks: [], inwardLinks: [] });

    const txn = transactionExecutor(
      {
        kind: 'transaction',
        steps: [
          {
            op: 'arrayPush',
            entity: 'documents',
            operation: 'pushOutward',
            input: { id: 'param:sourceId', value: 'param:targetId' },
          },
          {
            op: 'arrayPush',
            entity: 'documents',
            operation: 'pushInward',
            input: { id: 'param:targetId', value: 'param:sourceId' },
          },
        ],
      },
      { documents: docAdapter } as unknown as Parameters<typeof transactionExecutor>[1],
    );

    await txn({ sourceId: docA.id, targetId: docB.id });

    const updatedA = await ea.getById(docA.id as string);
    const updatedB = await ea.getById(docB.id as string);
    expect((updatedA as Record<string, unknown>).outwardLinks).toEqual([docB.id]);
    expect((updatedB as Record<string, unknown>).inwardLinks).toEqual([docA.id]);
  });

  it('arrayPush step resolves value from a previous step result', async () => {
    const ea = docAdapter as unknown as EntityAdapter<
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>
    >;
    const docA = await ea.create({ title: 'A', outwardLinks: [] });
    const docB = await ea.create({ title: 'B', outwardLinks: [] });

    const txn = transactionExecutor(
      {
        kind: 'transaction',
        steps: [
          // step 0: lookup docB to get its id into results
          {
            op: 'lookup',
            entity: 'documents',
            match: { id: 'param:targetId' },
          },
          // step 1: push result:0.id onto docA's outwardLinks
          {
            op: 'arrayPush',
            entity: 'documents',
            operation: 'pushOutward',
            input: { id: 'param:sourceId', value: 'result:0.id' },
          },
        ],
      },
      { documents: docAdapter } as unknown as Parameters<typeof transactionExecutor>[1],
    );

    await txn({ sourceId: docA.id, targetId: docB.id });
    const updatedA = await ea.getById(docA.id as string);
    expect((updatedA as Record<string, unknown>).outwardLinks).toEqual([docB.id]);
  });
});

// ---------------------------------------------------------------------------
// op.transaction — lookup step
// ---------------------------------------------------------------------------

describe('op.transaction — lookup step', () => {
  const docFactories = createEntityFactories(Document);
  const snapFactories = createEntityFactories(Snapshot);
  type DocAdapter = ReturnType<typeof docFactories.memory>;
  type SnapAdapter = ReturnType<typeof snapFactories.memory>;
  let docAdapter: DocAdapter;
  let snapAdapter: SnapAdapter;

  beforeEach(async () => {
    docAdapter = docFactories.memory();
    snapAdapter = snapFactories.memory();
    await docAdapter.clear();
    await snapAdapter.clear();
  });

  it('lookup step reads a record and exposes it via result:N.field', async () => {
    const snapEa = snapAdapter as unknown as EntityAdapter<
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>
    >;
    const snap = await snapEa.create({
      documentId: 'doc-1',
      title: 'Saved Title',
      body: 'old body',
    });

    const txn = transactionExecutor(
      {
        kind: 'transaction',
        steps: [
          // step 0: lookup the snapshot
          {
            op: 'lookup',
            entity: 'snapshots',
            match: { id: 'param:snapshotId' },
          },
        ],
      },
      { snapshots: snapAdapter } as unknown as Parameters<typeof transactionExecutor>[1],
    );

    const results = await txn({ snapshotId: snap.id });
    expect((results[0] as Record<string, unknown>).title).toBe('Saved Title');
    expect((results[0] as Record<string, unknown>).body).toBe('old body');
  });

  it('lookup result drives a subsequent write step — revert pattern', async () => {
    const docEa = docAdapter as unknown as EntityAdapter<
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>
    >;
    const snapEa = snapAdapter as unknown as EntityAdapter<
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>
    >;

    const doc = await docEa.create({ title: 'Current Title', body: 'current body' });
    const snap = await snapEa.create({
      documentId: doc.id,
      title: 'Snapshot Title',
      body: 'snapshot body',
    });

    const txn = transactionExecutor(
      {
        kind: 'transaction',
        steps: [
          // step 0: read the snapshot
          {
            op: 'lookup',
            entity: 'snapshots',
            match: { id: 'param:snapshotId' },
          },
          // step 1: update document fields from snapshot data
          {
            op: 'update',
            entity: 'documents',
            match: { id: 'param:docId' },
            set: { title: 'result:0.title', body: 'result:0.body' },
          },
          // step 2: create a new snapshot recording the revert
          {
            op: 'create',
            entity: 'snapshots',
            input: {
              documentId: 'param:docId',
              title: 'result:0.title',
              body: 'result:0.body',
              type: 'revert',
            },
          },
        ],
      },
      {
        documents: docAdapter,
        snapshots: snapAdapter,
      } as unknown as Parameters<typeof transactionExecutor>[1],
    );

    const results = await txn({ snapshotId: snap.id, docId: doc.id });

    // step 1 result: document updated with snapshot values
    expect((results[1] as Record<string, unknown>).title).toBe('Snapshot Title');
    expect((results[1] as Record<string, unknown>).body).toBe('snapshot body');

    // step 2 result: new revert snapshot created
    expect((results[2] as Record<string, unknown>).type).toBe('revert');
    expect((results[2] as Record<string, unknown>).title).toBe('Snapshot Title');

    // verify persistence
    const updatedDoc = await docEa.getById(doc.id as string);
    expect((updatedDoc as Record<string, unknown>).title).toBe('Snapshot Title');
  });

  it('lookup step returns null when record not found', async () => {
    const txn = transactionExecutor(
      {
        kind: 'transaction',
        steps: [
          {
            op: 'lookup',
            entity: 'documents',
            match: { id: 'param:id' },
          },
        ],
      },
      { documents: docAdapter } as unknown as Parameters<typeof transactionExecutor>[1],
    );

    const results = await txn({ id: 'nonexistent' });
    expect(results[0]).toBeNull();
  });
});
