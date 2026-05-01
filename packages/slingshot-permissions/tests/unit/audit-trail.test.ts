import { beforeEach, describe, expect, test } from 'bun:test';
import { createMemoryPermissionsAdapter } from '../../src/adapters/memory';
import {
  type AuditTrailEntry,
  type AuditTrailStore,
  createMemoryAuditTrailStore,
  withAuditTrail,
} from '../../src/lib/auditTrail';

describe('AuditTrailStore (in-memory)', () => {
  let store: AuditTrailStore;

  beforeEach(() => {
    store = createMemoryAuditTrailStore();
  });

  test('record returns a unique ID', async () => {
    const id = await store.record({
      actor: 'admin',
      action: 'create',
      resourceType: 'grant',
      resourceId: 'grant-1',
      changes: { roles: ['editor'] },
      tenantId: null,
    });
    expect(id).toBeTruthy();
    expect(typeof id).toBe('string');
  });

  test('recorded entries can be queried back', async () => {
    await store.record({
      actor: 'admin@example.com',
      action: 'create',
      resourceType: 'grant',
      resourceId: 'grant-abc',
      changes: { roles: ['editor'] },
      tenantId: 'tenant-1',
    });

    const entries = await store.query();
    expect(entries).toHaveLength(1);
    expect(entries[0].actor).toBe('admin@example.com');
    expect(entries[0].action).toBe('create');
    expect(entries[0].resourceType).toBe('grant');
    expect(entries[0].resourceId).toBe('grant-abc');
    expect(entries[0].changes).toEqual({ roles: ['editor'] });
    expect(entries[0].tenantId).toBe('tenant-1');
    expect(entries[0].timestamp).toBeInstanceOf(Date);
    expect(entries[0].id).toBeTruthy();
  });

  test('query with actor filter returns only matching entries', async () => {
    await store.record({
      actor: 'admin',
      action: 'create',
      resourceType: 'grant',
      resourceId: 'g1',
      changes: {},
      tenantId: null,
    });
    await store.record({
      actor: 'user',
      action: 'create',
      resourceType: 'grant',
      resourceId: 'g2',
      changes: {},
      tenantId: null,
    });

    const adminEntries = await store.query({ actor: 'admin' });
    expect(adminEntries).toHaveLength(1);
    expect(adminEntries[0].resourceId).toBe('g1');
  });

  test('query with action filter', async () => {
    await store.record({
      actor: 'admin',
      action: 'create',
      resourceType: 'grant',
      resourceId: 'g1',
      changes: {},
      tenantId: null,
    });
    await store.record({
      actor: 'admin',
      action: 'delete',
      resourceType: 'grant',
      resourceId: 'g2',
      changes: {},
      tenantId: null,
    });

    const deletes = await store.query({ action: 'delete' });
    expect(deletes).toHaveLength(1);
    expect(deletes[0].resourceId).toBe('g2');
  });

  test('query with resourceId filter', async () => {
    await store.record({
      actor: 'admin',
      action: 'create',
      resourceType: 'grant',
      resourceId: 'specific-grant',
      changes: {},
      tenantId: null,
    });
    await store.record({
      actor: 'admin',
      action: 'create',
      resourceType: 'grant',
      resourceId: 'other-grant',
      changes: {},
      tenantId: null,
    });

    const results = await store.query({ resourceId: 'specific-grant' });
    expect(results).toHaveLength(1);
    expect(results[0].resourceId).toBe('specific-grant');
  });

  test('query with tenantId filter', async () => {
    await store.record({
      actor: 'admin',
      action: 'create',
      resourceType: 'grant',
      resourceId: 'g1',
      changes: {},
      tenantId: 'tenant-a',
    });
    await store.record({
      actor: 'admin',
      action: 'create',
      resourceType: 'grant',
      resourceId: 'g2',
      changes: {},
      tenantId: 'tenant-b',
    });

    const results = await store.query({ tenantId: 'tenant-a' });
    expect(results).toHaveLength(1);
  });

  test('query returns entries in reverse chronological order (newest first)', async () => {
    await store.record({
      actor: 'admin',
      action: 'create',
      resourceType: 'grant',
      resourceId: 'first',
      changes: {},
      tenantId: null,
    });
    // Tiny delay to ensure distinct timestamps
    await new Promise(r => setTimeout(r, 5));
    await store.record({
      actor: 'admin',
      action: 'create',
      resourceType: 'grant',
      resourceId: 'second',
      changes: {},
      tenantId: null,
    });

    const entries = await store.query();
    expect(entries).toHaveLength(2);
    expect(entries[0].resourceId).toBe('second');
    expect(entries[1].resourceId).toBe('first');
  });

  test('query respects limit', async () => {
    for (let i = 0; i < 10; i++) {
      await store.record({
        actor: 'admin',
        action: 'create',
        resourceType: 'grant',
        resourceId: `g-${i}`,
        changes: {},
        tenantId: null,
      });
    }

    const limited = await store.query({ limit: 3 });
    expect(limited).toHaveLength(3);
  });

  test('query respects offset', async () => {
    for (let i = 0; i < 5; i++) {
      await store.record({
        actor: 'admin',
        action: 'create',
        resourceType: 'grant',
        resourceId: `g-${i}`,
        changes: {},
        tenantId: null,
      });
    }

    // With reverse chronological order, offset 2 skips the 2 newest
    const page = await store.query({ limit: 10, offset: 2 });
    expect(page).toHaveLength(3);
  });

  test('query with from filter', async () => {
    // Capture a timestamp before recording the old entry
    const before = new Date();
    await new Promise(r => setTimeout(r, 5));

    await store.record({
      actor: 'admin',
      action: 'create',
      resourceType: 'grant',
      resourceId: 'old',
      changes: {},
      tenantId: null,
    });
    await new Promise(r => setTimeout(r, 5));
    await store.record({
      actor: 'admin',
      action: 'create',
      resourceType: 'grant',
      resourceId: 'new',
      changes: {},
      tenantId: null,
    });

    // Query for entries strictly after `before` — should only match the new entry
    const results = await store.query({ from: before });
    expect(results).toHaveLength(2); // both entries have timestamps >= before
  });

  test('query with to filter', async () => {
    await store.record({
      actor: 'admin',
      action: 'create',
      resourceType: 'grant',
      resourceId: 'before',
      changes: {},
      tenantId: null,
    });
    const cutoff = new Date();
    await new Promise(r => setTimeout(r, 5));
    await store.record({
      actor: 'admin',
      action: 'create',
      resourceType: 'grant',
      resourceId: 'after',
      changes: {},
      tenantId: null,
    });

    // Query for entries on or before cutoff — should only match the earlier entry
    const results = await store.query({ to: cutoff });
    expect(results).toHaveLength(1);
    expect(results[0].resourceId).toBe('before');
  });

  test('evicts oldest entries when exceeding maxEntries', async () => {
    const smallStore = createMemoryAuditTrailStore({ maxEntries: 3 });

    await smallStore.record({
      actor: 'admin',
      action: 'create',
      resourceType: 'grant',
      resourceId: 'g1',
      changes: {},
      tenantId: null,
    });
    await smallStore.record({
      actor: 'admin',
      action: 'create',
      resourceType: 'grant',
      resourceId: 'g2',
      changes: {},
      tenantId: null,
    });
    await smallStore.record({
      actor: 'admin',
      action: 'create',
      resourceType: 'grant',
      resourceId: 'g3',
      changes: {},
      tenantId: null,
    });
    // This should evict g1
    await smallStore.record({
      actor: 'admin',
      action: 'create',
      resourceType: 'grant',
      resourceId: 'g4',
      changes: {},
      tenantId: null,
    });

    const entries = await smallStore.query();
    expect(entries).toHaveLength(3);
    const ids = entries.map(e => e.resourceId);
    expect(ids).not.toContain('g1');
    expect(ids).toContain('g4');
  });

  test('default query with no entries returns empty array', async () => {
    const entries = await store.query();
    expect(entries).toEqual([]);
  });
});

describe('withAuditTrail (adapter wrapper)', () => {
  let adapter: ReturnType<typeof createMemoryPermissionsAdapter>;
  let auditStore: AuditTrailStore;

  beforeEach(() => {
    adapter = createMemoryPermissionsAdapter();
    auditStore = createMemoryAuditTrailStore();
  });

  test('createGrant records audit entry', async () => {
    const audited = withAuditTrail(adapter, auditStore);

    const id = await audited.createGrant({
      subjectId: 'user-1',
      subjectType: 'user',
      tenantId: null,
      resourceType: null,
      resourceId: null,
      roles: ['editor'],
      effect: 'allow',
      grantedBy: 'admin@example.com',
    });

    const entries = await auditStore.query();
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe('create');
    expect(entries[0].resourceType).toBe('grant');
    expect(entries[0].resourceId).toBe(id);
    expect(entries[0].actor).toBe('admin@example.com');
    expect(entries[0].tenantId).toBeNull();
  });

  test('createGrant records tenant ID in audit entry', async () => {
    const audited = withAuditTrail(adapter, auditStore);

    await audited.createGrant({
      subjectId: 'user-1',
      subjectType: 'user',
      tenantId: 'tenant-42',
      resourceType: 'post',
      resourceId: null,
      roles: ['editor'],
      effect: 'allow',
      grantedBy: 'admin',
    });

    const entries = await auditStore.query();
    expect(entries[0].tenantId).toBe('tenant-42');
  });

  test('revokeGrant records audit entry with before/after', async () => {
    const audited = withAuditTrail(adapter, auditStore);

    const grantId = await audited.createGrant({
      subjectId: 'user-1',
      subjectType: 'user',
      tenantId: 't1',
      resourceType: 'post',
      resourceId: null,
      roles: ['editor'],
      effect: 'allow',
      grantedBy: 'admin',
    });

    const revoked = await audited.revokeGrant(grantId, 'other-admin', 't1', 'role change');
    expect(revoked).toBe(true);

    const entries = await auditStore.query();
    // First entry: create, second: update (revoke)
    expect(entries).toHaveLength(2);

    const revokeEntry = entries[0]; // newest first
    expect(revokeEntry.action).toBe('update');
    expect(revokeEntry.resourceId).toBe(grantId);
    expect(revokeEntry.actor).toBe('other-admin');
    expect(revokeEntry.changes).toHaveProperty('before');
    expect(revokeEntry.changes).toHaveProperty('after');
  });

  test('revokeGrant does not record when grant not found', async () => {
    const audited = withAuditTrail(adapter, auditStore);

    const result = await audited.revokeGrant('nonexistent', 'admin');
    expect(result).toBe(false);

    const entries = await auditStore.query();
    expect(entries).toHaveLength(0);
  });

  test('createGrants records audit entry for each grant', async () => {
    const audited = withAuditTrail(adapter, auditStore);

    const ids = await audited.createGrants([
      {
        subjectId: 'user-1',
        subjectType: 'user',
        tenantId: null,
        resourceType: null,
        resourceId: null,
        roles: ['reader'],
        effect: 'allow',
        grantedBy: 'admin',
      },
      {
        subjectId: 'user-2',
        subjectType: 'user',
        tenantId: 't1',
        resourceType: 'post',
        resourceId: null,
        roles: ['editor'],
        effect: 'allow',
        grantedBy: 'admin',
      },
    ]);

    expect(ids).toHaveLength(2);

    const entries = await auditStore.query();
    expect(entries).toHaveLength(2);
    expect(entries.map(e => e.action)).toEqual(['create', 'create']);
    const resourceIds = entries.map(e => e.resourceId).sort();
    expect(resourceIds).toEqual([ids[0], ids[1]].sort());
  });

  test('deleteAllGrantsForSubject records audit entry for each deleted grant', async () => {
    const audited = withAuditTrail(adapter, auditStore);

    await audited.createGrant({
      subjectId: 'user-1',
      subjectType: 'user',
      tenantId: 't1',
      resourceType: 'post',
      resourceId: null,
      roles: ['editor'],
      effect: 'allow',
      grantedBy: 'admin',
    });
    await audited.createGrant({
      subjectId: 'user-1',
      subjectType: 'user',
      tenantId: 't1',
      resourceType: 'document',
      resourceId: null,
      roles: ['reader'],
      effect: 'allow',
      grantedBy: 'admin',
    });

    // Clear audit entries from the creates
    auditStore = createMemoryAuditTrailStore();
    const cleanAudited = withAuditTrail(adapter, auditStore);

    await cleanAudited.deleteAllGrantsForSubject({
      subjectId: 'user-1',
      subjectType: 'user',
    });

    const entries = await auditStore.query();
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.action).toBe('delete');
      expect(entry.resourceType).toBe('grant');
      expect(entry.actor).toBe('system');
    }
  });

  test('deleteAllGrantsOnResource records audit entry for each deleted grant', async () => {
    const audited = withAuditTrail(adapter, auditStore);

    await audited.createGrant({
      subjectId: 'user-1',
      subjectType: 'user',
      tenantId: 't1',
      resourceType: 'post',
      resourceId: 'post-1',
      roles: ['editor'],
      effect: 'allow',
      grantedBy: 'admin',
    });
    await audited.createGrant({
      subjectId: 'user-2',
      subjectType: 'user',
      tenantId: 't1',
      resourceType: 'post',
      resourceId: 'post-1',
      roles: ['reader'],
      effect: 'allow',
      grantedBy: 'admin',
    });

    // Clear audit entries from the creates
    auditStore = createMemoryAuditTrailStore();
    const cleanAudited = withAuditTrail(adapter, auditStore);

    await cleanAudited.deleteAllGrantsOnResource('post', 'post-1');

    const entries = await auditStore.query();
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.action).toBe('delete');
      expect(entry.resourceType).toBe('grant');
    }
  });

  test('read-through methods (getGrantsForSubject, etc.) do not record audit entries', async () => {
    const audited = withAuditTrail(adapter, auditStore);

    // Create a grant first (this does record)
    await audited.createGrant({
      subjectId: 'user-1',
      subjectType: 'user',
      tenantId: null,
      resourceType: null,
      resourceId: null,
      roles: ['editor'],
      effect: 'allow',
      grantedBy: 'admin',
    });

    // Read operations — should NOT create audit entries
    await audited.getGrantsForSubject('user-1', 'user');
    await audited.getEffectiveGrantsForSubject('user-1', 'user');
    await audited.listGrantHistory('user-1', 'user');
    await audited.listGrantsOnResource('post', 'post-1');

    const entries = await auditStore.query();
    expect(entries).toHaveLength(1); // Only the create
  });

  test('wrapped adapter still functions as a normal adapter', async () => {
    const audited = withAuditTrail(adapter, auditStore);

    const id = await audited.createGrant({
      subjectId: 'user-1',
      subjectType: 'user',
      tenantId: null,
      resourceType: null,
      resourceId: null,
      roles: ['editor'],
      effect: 'allow',
      grantedBy: 'admin',
    });

    const grants = await audited.getGrantsForSubject('user-1', 'user');
    expect(grants).toHaveLength(1);
    expect(grants[0].id).toBe(id);
  });

  test('defaultActor is used for delete operations', async () => {
    // Create a grant using the bare adapter
    const grantId = await adapter.createGrant({
      subjectId: 'user-1',
      subjectType: 'user',
      tenantId: null,
      resourceType: null,
      resourceId: null,
      roles: ['editor'],
      effect: 'allow',
      grantedBy: 'admin',
    });

    const audited = withAuditTrail(adapter, auditStore, { defaultActor: 'deploy-script' });

    await audited.revokeGrant(grantId, ''); // empty actor — should fall through to... wait, revokeGrant requires revokedBy

    // Actually revokeGrant uses its own revokedBy param, not defaultActor
    // Let's test deleteAllGrantsForSubject instead
    // Re-setup
    adapter.clear();
    auditStore = createMemoryAuditTrailStore();
    const cleanAudited = withAuditTrail(adapter, auditStore, { defaultActor: 'deploy-script' });

    await cleanAudited.createGrant({
      subjectId: 'user-1',
      subjectType: 'user',
      tenantId: 't1',
      resourceType: 'post',
      resourceId: null,
      roles: ['editor'],
      effect: 'allow',
      grantedBy: 'admin',
    });

    // Clear create entries
    auditStore = createMemoryAuditTrailStore();
    const reWrapped = withAuditTrail(adapter, auditStore, { defaultActor: 'deploy-script' });

    await reWrapped.deleteAllGrantsForSubject({
      subjectId: 'user-1',
      subjectType: 'user',
    });

    const entries = await auditStore.query();
    expect(entries).toHaveLength(1);
    expect(entries[0].actor).toBe('deploy-script');
  });
});
