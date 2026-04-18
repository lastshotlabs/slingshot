import { describe, expect, it } from 'bun:test';
import { defineEntity, field, index } from '../../packages/slingshot-core/src/entityConfig';
import { op } from '../../packages/slingshot-entity/src/builders/op';
import { defineOperations } from '../../packages/slingshot-entity/src/defineOperations';
import { generate } from '../../packages/slingshot-entity/src/generate';
import { generateRoutes } from '../../packages/slingshot-entity/src/generators/routes';

// ---------------------------------------------------------------------------
// Test entity + operations
// ---------------------------------------------------------------------------

const Message = defineEntity('Message', {
  namespace: 'chat',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    roomId: field.string(),
    authorId: field.string(),
    content: field.string(),
    status: field.enum(['sent', 'delivered', 'read', 'deleted'], { default: 'sent' }),
    score: field.integer({ default: 0 }),
    createdAt: field.date({ default: 'now' }),
  },
  indexes: [index(['roomId', 'createdAt'], { direction: 'desc' })],
  softDelete: { field: 'status', value: 'deleted' },
});

const AnyMessage = Message as any;
const MessageOps = defineOperations(AnyMessage, {
  getByRoom: op.lookup({ fields: { roomId: 'param:roomId' }, returns: 'many' }),
  getOneByRoomAndAuthor: op.lookup({
    fields: { roomId: 'param:roomId', authorId: 'param:authorId' },
    returns: 'one',
  }),
  isSent: op.exists({ fields: { id: 'param:id' }, check: { status: 'sent' } }),
  markDelivered: op.transition({
    field: 'status',
    from: 'sent',
    to: 'delivered',
    match: { id: 'param:id' },
  }),
  updateContent: op.fieldUpdate({ match: { id: 'param:id' }, set: ['content'] }),
  deleteByRoom: op.batch({
    action: 'delete',
    filter: { roomId: 'param:roomId' },
    returns: 'count',
  }),
  markAllRead: op.batch({
    action: 'update',
    filter: { roomId: 'param:roomId', status: 'delivered' },
    set: { status: 'read' },
    returns: 'count',
  }),
  searchContent: op.search({ fields: ['content'] }),
  countByRoom: op.aggregate({ groupBy: 'roomId', compute: { count: 'count' } }),
  upsertReaction: op.upsert({
    match: ['roomId', 'authorId'],
    set: ['content'],
    onCreate: { id: 'uuid', createdAt: 'now' },
  }),
  consumeToken: op.consume({ filter: { id: 'param:id' }, returns: 'boolean' }),
});

// ---------------------------------------------------------------------------
// Route generation (standalone)
// ---------------------------------------------------------------------------

describe('Route Generation', () => {
  const routes = generateRoutes(AnyMessage, MessageOps.operations);

  describe('structure', () => {
    it('generates valid TypeScript source', () => {
      expect(routes).toContain("import { OpenAPIHono } from '@hono/zod-openapi'");
      expect(routes).toContain("import { z } from 'zod'");
      expect(routes).toContain("from '@lastshotlabs/slingshot-core'");
    });

    it('exports a factory function', () => {
      expect(routes).toContain(
        'export function createMessageRoutes(adapter: MessageAdapter): OpenAPIHono',
      );
      expect(routes).toContain('return router;');
    });

    it('imports generated schemas', () => {
      expect(routes).toContain('messageSchema');
      expect(routes).toContain('createMessageSchema');
      expect(routes).toContain('updateMessageSchema');
      expect(routes).toContain('listMessageOptionsSchema');
    });

    it('imports adapter type', () => {
      expect(routes).toContain("import type { MessageAdapter } from './adapter'");
    });
  });

  describe('CRUD routes', () => {
    it('generates POST /messages (create)', () => {
      expect(routes).toContain("method: 'post'");
      expect(routes).toContain("path: '/messages'");
      expect(routes).toContain('adapter.create(input)');
      expect(routes).toContain('201');
    });

    it('generates GET /messages/{id} (getById)', () => {
      expect(routes).toContain("path: '/messages/{id}'");
      expect(routes).toContain('adapter.getById(id)');
      expect(routes).toContain('404');
    });

    it('generates PATCH /messages/{id} (update)', () => {
      expect(routes).toContain("method: 'patch'");
      expect(routes).toContain('adapter.update(id, input)');
    });

    it('generates DELETE /messages/{id} (delete)', () => {
      expect(routes).toContain("method: 'delete'");
      expect(routes).toContain('adapter.delete(id)');
      expect(routes).toContain('204');
    });

    it('generates GET /messages (list)', () => {
      expect(routes).toContain("summary: 'List Message'");
      expect(routes).toContain('adapter.list(opts)');
    });
  });

  describe('operation routes', () => {
    it('generates lookup (many) route', () => {
      expect(routes).toContain("path: '/messages/get-by-room/{roomId}'");
      expect(routes).toContain('.getByRoom(params)');
    });

    it('generates lookup (one) route', () => {
      expect(routes).toContain("path: '/messages/get-one-by-room-and-author/{roomId}/{authorId}'");
      expect(routes).toContain('.getOneByRoomAndAuthor(params)');
    });

    it('generates exists route with HEAD method', () => {
      expect(routes).toContain("method: 'head'");
      expect(routes).toContain('.isSent(params)');
    });

    it('generates transition route with 409 response', () => {
      expect(routes).toContain("path: '/messages/mark-delivered'");
      expect(routes).toContain('.markDelivered(params)');
      expect(routes).toContain('409');
      expect(routes).toContain('Precondition failed');
    });

    it('generates fieldUpdate route', () => {
      expect(routes).toContain("path: '/messages/update-content'");
      expect(routes).toContain('.updateContent(params, input)');
    });

    it('generates batch delete route', () => {
      expect(routes).toContain("path: '/messages/batch/delete-by-room'");
      expect(routes).toContain('.deleteByRoom(params)');
      expect(routes).toContain('count');
    });

    it('generates batch update route', () => {
      expect(routes).toContain("path: '/messages/batch/mark-all-read'");
      expect(routes).toContain('.markAllRead(params)');
    });

    it('generates search route with query param and filter support', () => {
      expect(routes).toContain("path: '/messages/search'");
      expect(routes).toContain('.searchContent(query.q');
      expect(routes).toContain('q: z.string()');
      expect(routes).toContain('limit: z.coerce.number().optional()');
    });

    it('generates aggregate route', () => {
      expect(routes).toContain("path: '/messages/aggregate/count-by-room'");
      expect(routes).toContain('.countByRoom(params)');
    });

    it('generates upsert route with PUT method', () => {
      expect(routes).toContain("method: 'put'");
      expect(routes).toContain("path: '/messages/upsert-reaction'");
      expect(routes).toContain('.upsertReaction(input)');
    });

    it('generates consume route', () => {
      expect(routes).toContain("path: '/messages/consume/consume-token'");
      expect(routes).toContain('.consumeToken(params)');
      expect(routes).toContain('consumed');
    });
  });

  describe('OpenAPI metadata', () => {
    it('uses entity name as tag', () => {
      expect(routes).toContain("tags: ['Message']");
    });

    it('includes summaries', () => {
      expect(routes).toContain("summary: 'Create Message'");
      expect(routes).toContain("summary: 'Get Message by ID'");
      expect(routes).toContain("summary: 'getByRoom'");
    });

    it('defines error schema', () => {
      expect(routes).toContain('errorSchema');
      expect(routes).toContain('z.object({ error: z.string()');
    });
  });
});

// ---------------------------------------------------------------------------
// Integration with generate()
// ---------------------------------------------------------------------------

describe('Route generation via generate()', () => {
  it('includes routes.ts when operations provided', () => {
    const files = generate(AnyMessage, { operations: MessageOps.operations });
    expect(files['routes.ts']).toBeDefined();
    expect(files['routes.ts']).toContain('createMessageRoutes');
  });

  it('does not include routes.ts without operations', () => {
    const files = generate(AnyMessage);
    expect(files['routes.ts']).toBeUndefined();
  });

  it('barrel export includes routes', () => {
    const files = generate(AnyMessage, { operations: MessageOps.operations });
    expect(files['index.ts']).toContain("export * from './routes'");
  });
});

// ---------------------------------------------------------------------------
// Entity without operations
// ---------------------------------------------------------------------------

describe('CRUD-only route generation', () => {
  it('generates only CRUD routes when no operations', () => {
    const routes = generateRoutes(AnyMessage);
    expect(routes).toContain("path: '/messages'");
    expect(routes).toContain("path: '/messages/{id}'");
    expect(routes).toContain('adapter.create');
    expect(routes).toContain('adapter.getById');
    expect(routes).toContain('adapter.update');
    expect(routes).toContain('adapter.delete');
    expect(routes).toContain('adapter.list');
    // No operation routes
    expect(routes).not.toContain('getByRoom');
    expect(routes).not.toContain('markDelivered');
  });
});

// ---------------------------------------------------------------------------
// Path generation
// ---------------------------------------------------------------------------

describe('Path conventions', () => {
  it('pluralizes and kebab-cases entity name', () => {
    const LedgerItem = defineEntity('LedgerItem', {
      fields: { id: field.string({ primary: true }) },
    }) as any;
    const routes = generateRoutes(LedgerItem);
    expect(routes).toContain("path: '/ledger-items'");
    expect(routes).toContain("path: '/ledger-items/{id}'");
  });

  it('kebab-cases operation names', () => {
    const routes = generateRoutes(AnyMessage, MessageOps.operations);
    expect(routes).toContain('mark-delivered');
    expect(routes).toContain('delete-by-room');
    expect(routes).toContain('mark-all-read');
    expect(routes).toContain('count-by-room');
  });
});
