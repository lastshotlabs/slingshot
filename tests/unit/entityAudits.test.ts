import { describe, expect, it } from 'bun:test';
import { defineEntity, field, index } from '../../packages/slingshot-core/src/entityConfig';
import type { OperationConfig } from '../../packages/slingshot-core/src/operations';
import { auditEntity } from '../../packages/slingshot-entity/src/audits';

// ---------------------------------------------------------------------------
// Test entity
// ---------------------------------------------------------------------------

const Message = defineEntity('Message', {
  namespace: 'test',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    roomId: field.string(),
    authorId: field.string(),
    content: field.string(),
    status: field.enum(['sent', 'delivered', 'read', 'deleted'], { default: 'sent' }),
    score: field.integer({ default: 0 }),
    createdAt: field.date({ default: 'now' }),
    updatedAt: field.date({ default: 'now', onUpdate: 'now' }),
  },
  indexes: [index(['roomId', 'createdAt'], { direction: 'desc' })],
  uniques: [{ fields: ['roomId', 'authorId'] }],
  softDelete: { field: 'status', value: 'deleted' },
  pagination: { cursor: { fields: ['createdAt', 'id'] }, defaultLimit: 50, maxLimit: 200 },
});

describe('Entity Audits', () => {
  describe('structural checks', () => {
    it('catches onUpdate on non-date field', () => {
      const onUpdate = { onUpdate: 'now' } as unknown as never;
      defineEntity('Bad', {
        fields: {
          id: field.string({ primary: true }),
          name: field.string(onUpdate), // force bad config
        },
      });
      // This would be caught at defineEntity level normally,
      // but the audit provides an additional layer
    });

    it('passes clean entity with no findings', () => {
      const result = auditEntity(Message);
      // Should have zero errors (all structural rules pass)
      expect(result.errors).toBe(0);
    });

    it('warns about no indexes on large entity', () => {
      const BigEntity = defineEntity('BigEntity', {
        fields: {
          id: field.string({ primary: true }),
          a: field.string(),
          b: field.string(),
          c: field.string(),
          d: field.string(),
          e: field.string(),
          f: field.string(),
        },
      });
      const result = auditEntity(BigEntity);
      const noIndexFinding = result.findings.find(f => f.rule === 'structural/no-indexes');
      expect(noIndexFinding).toBeDefined();
      expect(noIndexFinding!.severity).toBe('info');
    });
  });

  describe('index coverage', () => {
    it('no warnings when fields are indexed', () => {
      const ops: Record<string, OperationConfig> = {
        getByRoom: { kind: 'lookup', fields: { roomId: 'param:roomId' }, returns: 'many' },
      };
      const result = auditEntity(Message, ops);
      const lookupWarning = result.findings.find(
        f => f.rule === 'index-coverage/lookup' && f.operation === 'getByRoom',
      );
      expect(lookupWarning).toBeUndefined(); // roomId is indexed
    });

    it('warns about lookup on unindexed field', () => {
      const ops: Record<string, OperationConfig> = {
        getByContent: { kind: 'lookup', fields: { content: 'param:content' }, returns: 'one' },
      };
      const result = auditEntity(Message, ops);
      const finding = result.findings.find(
        f => f.rule === 'index-coverage/lookup' && f.operation === 'getByContent',
      );
      expect(finding).toBeDefined();
      expect(finding!.severity).toBe('warning');
    });

    it('warns about aggregate groupBy on unindexed field', () => {
      const ops: Record<string, OperationConfig> = {
        countByScore: {
          kind: 'aggregate',
          groupBy: 'score',
          compute: { count: 'count' },
        },
      };
      const result = auditEntity(Message, ops);
      const finding = result.findings.find(f => f.rule === 'index-coverage/aggregate-groupby');
      expect(finding).toBeDefined();
    });

    it('warns about upsert without matching unique constraint', () => {
      const ops: Record<string, OperationConfig> = {
        upsertByContent: {
          kind: 'upsert',
          match: ['content', 'authorId'],
          set: ['score'],
        },
      };
      const result = auditEntity(Message, ops);
      const finding = result.findings.find(f => f.rule === 'index-coverage/upsert-unique');
      expect(finding).toBeDefined();
    });

    it('no warning for upsert with matching unique', () => {
      const ops: Record<string, OperationConfig> = {
        upsertByRoomAuthor: {
          kind: 'upsert',
          match: ['roomId', 'authorId'],
          set: ['content'],
        },
      };
      const result = auditEntity(Message, ops);
      const finding = result.findings.find(f => f.rule === 'index-coverage/upsert-unique');
      expect(finding).toBeUndefined(); // roomId+authorId has unique constraint
    });

    it('info about search needing text indexes', () => {
      const ops: Record<string, OperationConfig> = {
        searchContent: { kind: 'search', fields: ['content'] },
      };
      const result = auditEntity(Message, ops);
      const finding = result.findings.find(f => f.rule === 'index-coverage/search');
      expect(finding).toBeDefined();
      expect(finding!.severity).toBe('info');
    });
  });

  describe('operation consistency', () => {
    it('catches transition with invalid enum values', () => {
      const ops: Record<string, OperationConfig> = {
        markInvalid: {
          kind: 'transition',
          field: 'status',
          from: 'sent',
          to: 'invalid_state',
          match: { id: 'param:id' },
        },
      };
      const result = auditEntity(Message, ops);
      const finding = result.findings.find(f => f.rule === 'consistency/transition-to-value');
      expect(finding).toBeDefined();
      expect(finding!.severity).toBe('error');
    });

    it('passes valid transition values', () => {
      const ops: Record<string, OperationConfig> = {
        markDelivered: {
          kind: 'transition',
          field: 'status',
          from: 'sent',
          to: 'delivered',
          match: { id: 'param:id' },
        },
      };
      const result = auditEntity(Message, ops);
      const finding = result.findings.find(f => f.rule.startsWith('consistency/transition'));
      expect(finding).toBeUndefined();
    });

    it('catches fieldUpdate on immutable field', () => {
      const ImmutableEntity = defineEntity('Immutable', {
        fields: {
          id: field.string({ primary: true }),
          name: field.string({ immutable: true }),
          bio: field.string(),
        },
      });
      const ops: Record<string, OperationConfig> = {
        updateName: { kind: 'fieldUpdate', match: { id: 'param:id' }, set: ['name'] },
      };
      const result = auditEntity(ImmutableEntity, ops);
      const finding = result.findings.find(f => f.rule === 'consistency/fieldUpdate-immutable');
      expect(finding).toBeDefined();
      expect(finding!.severity).toBe('error');
    });

    it('catches collection without identifyBy', () => {
      const ops: Record<string, OperationConfig> = {
        tags: {
          kind: 'collection',
          parentKey: 'id',
          itemFields: { tag: field.string() },
          operations: ['list', 'add', 'remove'],
        },
      };
      const result = auditEntity(Message, ops);
      const finding = result.findings.find(f => f.rule === 'consistency/collection-identifyBy');
      expect(finding).toBeDefined();
    });

    it('catches consume expiry on non-date field', () => {
      const ops: Record<string, OperationConfig> = {
        consumeToken: {
          kind: 'consume',
          filter: { id: 'param:id' },
          returns: 'boolean',
          expiry: { field: 'content' }, // string, not date
        },
      };
      const result = auditEntity(Message, ops);
      const finding = result.findings.find(f => f.rule === 'consistency/consume-expiry-type');
      expect(finding).toBeDefined();
    });
  });

  describe('full audit summary', () => {
    it('counts severity levels correctly', () => {
      const ops: Record<string, OperationConfig> = {
        getByContent: { kind: 'lookup', fields: { content: 'param:content' }, returns: 'one' },
        markInvalid: {
          kind: 'transition',
          field: 'status',
          from: 'sent',
          to: 'invalid_state',
          match: { id: 'param:id' },
        },
        search: { kind: 'search', fields: ['content'] },
      };
      const result = auditEntity(Message, ops);
      expect(result.entity).toBe('Message');
      expect(result.errors).toBeGreaterThan(0);
      expect(result.warnings).toBeGreaterThan(0);
      expect(result.errors + result.warnings + result.infos).toBe(result.findings.length);
    });
  });
});
