/**
 * Consumer shape hardening tests — covers Phases 2-5 of the
 * consumer-shape-hardening spec.
 *
 * Phase 2: Entity system fields and storage field mapping
 * Phase 3: Manifest helper payload-shape decoupling
 * Phase 4: Operation registry
 * Phase 5: Storage convention configuration
 */
import { describe, expect, mock, test } from 'bun:test';
import type { EntityRoutePolicyConfig } from '@lastshotlabs/slingshot-core';
import {
  applyDefaults,
  applyOnUpdate,
  resolveAutoDefault,
} from '../../src/configDriven/fieldUtils';
import { defineEntity, field } from '../../src/defineEntity';
import { buildPolicyAction, policyAppliesToOp } from '../../src/policy/resolvePolicy';
import { wireActivityLog } from '../../src/wiring/activityLog';
import { wireAutoGrant } from '../../src/wiring/autoGrant';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockBus() {
  const subscriptions: Array<{
    event: string;
    handler: (p: Record<string, unknown>) => Promise<void>;
  }> = [];
  return {
    on: (event: string, handler: (p: Record<string, unknown>) => Promise<void>) => {
      subscriptions.push({ event, handler });
    },
    subscriptions,
  };
}

// ---------------------------------------------------------------------------
// Phase 2: Entity System Fields and Storage Field Mapping
// ---------------------------------------------------------------------------

describe('Phase 2: entity system fields', () => {
  test('default system field names resolve correctly', () => {
    const entity = defineEntity('Widget', {
      fields: {
        id: field.string({ primary: true, default: 'uuid' }),
        name: field.string(),
      },
    });

    expect(entity._systemFields.createdBy).toBe('createdBy');
    expect(entity._systemFields.updatedBy).toBe('updatedBy');
    expect(entity._systemFields.ownerField).toBe('ownerId');
    expect(entity._systemFields.tenantField).toBe('tenantId');
    expect(entity._systemFields.version).toBe('version');
  });

  test('custom system field names override defaults', () => {
    const entity = defineEntity('Widget', {
      fields: {
        id: field.string({ primary: true, default: 'uuid' }),
        name: field.string(),
      },
      systemFields: {
        createdBy: 'author',
        updatedBy: 'lastEditor',
        ownerField: 'owner',
        tenantField: 'workspace',
        version: 'rev',
      },
    });

    expect(entity._systemFields.createdBy).toBe('author');
    expect(entity._systemFields.updatedBy).toBe('lastEditor');
    expect(entity._systemFields.ownerField).toBe('owner');
    expect(entity._systemFields.tenantField).toBe('workspace');
    expect(entity._systemFields.version).toBe('rev');
  });

  test('tenant config field feeds into tenantField default', () => {
    const entity = defineEntity('Widget', {
      fields: {
        id: field.string({ primary: true, default: 'uuid' }),
        orgId: field.string(),
      },
      tenant: { field: 'orgId' },
    });

    expect(entity._systemFields.tenantField).toBe('orgId');
  });

  test('explicit systemFields.tenantField overrides tenant.field', () => {
    const entity = defineEntity('Widget', {
      fields: {
        id: field.string({ primary: true, default: 'uuid' }),
        orgId: field.string(),
      },
      tenant: { field: 'orgId' },
      systemFields: { tenantField: 'workspace' },
    });

    expect(entity._systemFields.tenantField).toBe('workspace');
  });
});

describe('Phase 2: storage field mapping', () => {
  test('default storage fields resolve correctly', () => {
    const entity = defineEntity('Widget', {
      fields: { id: field.string({ primary: true, default: 'uuid' }) },
    });

    expect(entity._storageFields.mongoPkField).toBe('_id');
    expect(entity._storageFields.ttlField).toBe('_expires_at');
  });

  test('custom storage field names override defaults', () => {
    const entity = defineEntity('Widget', {
      fields: { id: field.string({ primary: true, default: 'uuid' }) },
      storageFields: {
        mongoPkField: 'pk',
        ttlField: 'expiresAt',
      },
    });

    expect(entity._storageFields.mongoPkField).toBe('pk');
    expect(entity._storageFields.ttlField).toBe('expiresAt');
  });
});

// ---------------------------------------------------------------------------
// Phase 3: Manifest Helper Payload-Shape Decoupling
// ---------------------------------------------------------------------------

describe('Phase 3: wireActivityLog with configurable fields', () => {
  test('uses resolved entity fields for tenant and resource ID', async () => {
    const bus = createMockBus();
    const adapter = { create: mock(() => Promise.resolve({})) };

    wireActivityLog(
      bus as never,
      'Project',
      {
        entity: 'Activity',
        resourceType: 'project',
        events: { created: { action: 'created' } },
      },
      { created: 'project.created' },
      adapter,
      { pkField: 'projectId', tenantField: 'workspaceId' },
    );

    expect(bus.subscriptions).toHaveLength(1);
    await bus.subscriptions[0].handler({
      projectId: 'proj-1',
      workspaceId: 'ws-1',
      createdBy: 'user-1',
    });

    expect(adapter.create).toHaveBeenCalledWith({
      orgId: 'ws-1',
      actorId: 'user-1',
      resourceType: 'project',
      resourceId: 'proj-1',
      action: 'created',
      meta: null,
    });
  });

  test('explicit config fields override resolved fields', async () => {
    const bus = createMockBus();
    const adapter = { create: mock(() => Promise.resolve({})) };

    wireActivityLog(
      bus as never,
      'Project',
      {
        entity: 'Activity',
        resourceType: 'project',
        tenantIdField: 'orgId',
        resourceIdField: 'id',
        events: { created: { action: 'created' } },
      },
      { created: 'project.created' },
      adapter,
      { pkField: 'projectId', tenantField: 'workspaceId' },
    );

    await bus.subscriptions[0].handler({
      id: 'proj-1',
      orgId: 'org-1',
      createdBy: 'user-1',
    });

    expect(adapter.create).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'org-1',
        resourceId: 'proj-1',
      }),
    );
  });

  test('custom actorIdFields override default actor resolution', async () => {
    const bus = createMockBus();
    const adapter = { create: mock(() => Promise.resolve({})) };

    wireActivityLog(
      bus as never,
      'Task',
      {
        entity: 'Activity',
        resourceType: 'task',
        actorIdFields: ['assignee', 'reporter'],
        events: { created: { action: 'created' } },
      },
      { created: 'task.created' },
      adapter,
    );

    await bus.subscriptions[0].handler({
      id: 'task-1',
      orgId: 'org-1',
      assignee: 'user-a',
      reporter: 'user-b',
    });

    expect(adapter.create).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'user-a' }));
  });
});

describe('Phase 3: wireAutoGrant with configurable fields', () => {
  test('uses resolved entity fields for resource and tenant ID', async () => {
    const bus = createMockBus();
    const permsAdapter = { createGrant: mock(() => Promise.resolve('grant-1')) };

    wireAutoGrant(
      bus as never,
      'Project',
      'project.created',
      { on: 'created', role: 'owner', subjectField: 'createdBy' },
      'project',
      permsAdapter as never,
      { pkField: 'projectId', tenantField: 'workspaceId' },
    );

    await bus.subscriptions[0].handler({
      projectId: 'proj-1',
      workspaceId: 'ws-1',
      createdBy: 'user-1',
    });

    expect(permsAdapter.createGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectId: 'user-1',
        resourceId: 'proj-1',
        tenantId: 'ws-1',
      }),
    );
  });

  test('explicit config fields override resolved fields', async () => {
    const bus = createMockBus();
    const permsAdapter = { createGrant: mock(() => Promise.resolve('grant-1')) };

    wireAutoGrant(
      bus as never,
      'Project',
      'project.created',
      {
        on: 'created',
        role: 'owner',
        subjectField: 'author',
        resourceIdField: 'uid',
        tenantIdField: 'company',
      },
      'project',
      permsAdapter as never,
      { pkField: 'projectId', tenantField: 'workspaceId' },
    );

    await bus.subscriptions[0].handler({
      uid: 'proj-1',
      company: 'co-1',
      author: 'user-1',
    });

    expect(permsAdapter.createGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectId: 'user-1',
        resourceId: 'proj-1',
        tenantId: 'co-1',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Phase 4: Operation Registry
// ---------------------------------------------------------------------------

describe('Phase 4: operation registry', () => {
  test('CRUD ops map to their own kind', () => {
    expect(buildPolicyAction('create')).toEqual({ kind: 'create' });
    expect(buildPolicyAction('list')).toEqual({ kind: 'list' });
    expect(buildPolicyAction('get')).toEqual({ kind: 'get' });
    expect(buildPolicyAction('update')).toEqual({ kind: 'update' });
    expect(buildPolicyAction('delete')).toEqual({ kind: 'delete' });
  });

  test('named ops map to kind: operation', () => {
    expect(buildPolicyAction('publish')).toEqual({ kind: 'operation', name: 'publish' });
    expect(buildPolicyAction('archive')).toEqual({ kind: 'operation', name: 'archive' });
  });

  test('policyAppliesToOp normalizes CRUD ops directly', () => {
    const config = { resolver: 'test', applyTo: ['create', 'update'] } as EntityRoutePolicyConfig;
    expect(policyAppliesToOp(config, 'create')).toBe(true);
    expect(policyAppliesToOp(config, 'update')).toBe(true);
    expect(policyAppliesToOp(config, 'delete')).toBe(false);
  });

  test('policyAppliesToOp normalizes named ops with operation: prefix', () => {
    const config = { resolver: 'test', applyTo: ['operation:publish'] } as EntityRoutePolicyConfig;
    expect(policyAppliesToOp(config, 'publish')).toBe(true);
    expect(policyAppliesToOp(config, 'archive')).toBe(false);
  });

  test('policyAppliesToOp with no applyTo applies to everything', () => {
    const config = { resolver: 'test' } as EntityRoutePolicyConfig;
    expect(policyAppliesToOp(config, 'create')).toBe(true);
    expect(policyAppliesToOp(config, 'publish')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 5: Storage Convention Configuration
// ---------------------------------------------------------------------------

describe('Phase 5: storage conventions on entity config', () => {
  test('conventions are resolved and accessible on entity config', () => {
    const redisKey = ({
      appName,
      storageName,
      pk,
    }: {
      appName: string;
      storageName: string;
      pk: string | number;
    }) => `${appName}/${storageName}/${pk}`;
    const autoDefault = (kind: string) => (kind === 'ulid' ? 'test-ulid' : undefined);

    const entity = defineEntity('Widget', {
      fields: { id: field.string({ primary: true, default: 'uuid' }) },
      conventions: { redisKey, autoDefault },
    });

    expect(entity._conventions.redisKey).toBe(redisKey);
    expect(entity._conventions.autoDefault).toBe(autoDefault);
    expect(entity._conventions.onUpdate).toBeUndefined();
  });

  test('conventions default to undefined when omitted', () => {
    const entity = defineEntity('Widget', {
      fields: { id: field.string({ primary: true, default: 'uuid' }) },
    });

    expect(entity._conventions.redisKey).toBeUndefined();
    expect(entity._conventions.autoDefault).toBeUndefined();
    expect(entity._conventions.onUpdate).toBeUndefined();
  });
});

describe('Phase 5: custom auto-default resolver', () => {
  test('built-in uuid still works', () => {
    const result = resolveAutoDefault('uuid');
    expect(typeof result).toBe('string');
    expect((result as string).length).toBeGreaterThan(0);
  });

  test('built-in cuid still works', () => {
    const result = resolveAutoDefault('cuid');
    expect(typeof result).toBe('string');
    expect((result as string).startsWith('c')).toBe(true);
  });

  test('built-in now still works', () => {
    const result = resolveAutoDefault('now');
    expect(result).toBeInstanceOf(Date);
  });

  test('custom resolver handles unknown sentinels', () => {
    const custom = (kind: string) => (kind === 'ulid' ? 'generated-ulid' : undefined);
    expect(resolveAutoDefault('ulid', custom)).toBe('generated-ulid');
  });

  test('throws for unknown sentinel without custom resolver', () => {
    expect(() => resolveAutoDefault('ulid')).toThrow('Unknown auto-default sentinel');
  });

  test('throws for unknown sentinel when custom returns undefined', () => {
    const custom = () => undefined;
    expect(() => resolveAutoDefault('ulid', custom)).toThrow('Unknown auto-default sentinel');
  });
});

describe('Phase 5: applyDefaults with custom resolver', () => {
  test('applies custom auto-default for non-built-in sentinel', () => {
    const fields = {
      id: {
        type: 'string' as const,
        default: 'ulid',
        primary: true,
        immutable: false,
        optional: false,
      },
      name: { type: 'string' as const, primary: false, immutable: false, optional: false },
    };
    const custom = (kind: string) => (kind === 'ulid' ? 'my-ulid-value' : undefined);

    const record = applyDefaults({ name: 'test' }, fields, custom);
    expect(record.id).toBe('my-ulid-value');
    expect(record.name).toBe('test');
  });

  test('falls through to literal default when custom returns undefined', () => {
    const fields = {
      status: {
        type: 'string' as const,
        default: 'draft',
        primary: false,
        immutable: false,
        optional: false,
      },
    };
    const custom = () => undefined;

    const record = applyDefaults({}, fields, custom);
    expect(record.status).toBe('draft');
  });

  test('built-in auto-defaults work without custom resolver', () => {
    const fields = {
      id: {
        type: 'string' as const,
        default: 'uuid' as const,
        primary: true,
        immutable: false,
        optional: false,
      },
      createdAt: {
        type: 'date' as const,
        default: 'now' as const,
        primary: false,
        immutable: false,
        optional: false,
      },
    };

    const record = applyDefaults({}, fields);
    expect(typeof record.id).toBe('string');
    expect(record.createdAt).toBeInstanceOf(Date);
  });
});

describe('Phase 5: applyOnUpdate with custom resolver', () => {
  test('built-in now still works', () => {
    const fields = {
      updatedAt: {
        type: 'date' as const,
        onUpdate: 'now' as const,
        primary: false,
        immutable: false,
        optional: false,
      },
    };
    const result = applyOnUpdate({ name: 'changed' }, fields);
    expect(result.updatedAt).toBeInstanceOf(Date);
    expect(result.name).toBe('changed');
  });

  test('custom onUpdate resolver handles non-built-in sentinel', () => {
    const fields = {
      version: {
        type: 'number' as const,
        onUpdate: 'increment',
        primary: false,
        immutable: false,
        optional: false,
      },
    };
    const custom = (kind: string) => (kind === 'increment' ? 42 : undefined);

    const result = applyOnUpdate({ name: 'changed' }, fields as never, custom);
    expect(result.version).toBe(42);
  });

  test('custom onUpdate skips field when resolver returns undefined', () => {
    const fields = {
      version: {
        type: 'number' as const,
        onUpdate: 'unknown-strategy',
        primary: false,
        immutable: false,
        optional: false,
      },
    };
    const custom = () => undefined;

    const result = applyOnUpdate({ name: 'changed' }, fields as never, custom);
    expect(result.version).toBeUndefined();
  });
});
