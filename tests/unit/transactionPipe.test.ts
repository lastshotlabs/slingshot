import { beforeEach, describe, expect, it } from 'bun:test';
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
      adapter as any,
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
      adapter as any,
    );

    expect(pipe({})).rejects.toThrow("Operation 'nonexistent' not found");
  });
});

// ---------------------------------------------------------------------------
// op.transaction — arrayPush / arrayPull steps
// ---------------------------------------------------------------------------

describe('op.transaction — arrayPush and arrayPull steps', () => {
  const docFactories = createEntityFactories(Document);
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
            match: { id: 'param:id' },
            field: 'outwardLinks',
            value: 'param:targetId',
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
            match: { id: 'param:id' },
            field: 'outwardLinks',
            value: 'param:targetId',
            dedupe: true,
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
            match: { id: 'param:id' },
            field: 'outwardLinks',
            value: 'param:targetId',
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
            match: { id: 'param:sourceId' },
            field: 'outwardLinks',
            value: 'param:targetId',
            dedupe: true,
          },
          {
            op: 'arrayPush',
            entity: 'documents',
            match: { id: 'param:targetId' },
            field: 'inwardLinks',
            value: 'param:sourceId',
            dedupe: true,
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
            match: { id: 'param:sourceId' },
            field: 'outwardLinks',
            value: 'result:0.id',
            dedupe: true,
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

  it('lookup step returns empty object when record not found', async () => {
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
    expect(results[0]).toEqual({});
  });
});
