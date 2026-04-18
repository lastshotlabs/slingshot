import { describe, expect, it } from 'bun:test';
import { createInMemoryAuditLog } from '../../src/lib/manifestAdminProviders';

// ---------------------------------------------------------------------------
// In-memory audit log
// ---------------------------------------------------------------------------

describe('createInMemoryAuditLog', () => {
  it('stores and retrieves log entries', async () => {
    const log = createInMemoryAuditLog();

    await log.logEntry({
      userId: 'u1',
      action: 'user.suspend',
      path: '/admin/users/u2/suspend',
      method: 'POST',
      timestamp: new Date().toISOString(),
    } as never);

    const result = await log.getLogs({});
    expect(result.items).toHaveLength(1);
    expect(result.items[0].userId).toBe('u1');
  });

  it('filters by userId', async () => {
    const log = createInMemoryAuditLog();

    await log.logEntry({ userId: 'u1', action: 'a', path: '/a', method: 'GET' } as never);
    await log.logEntry({ userId: 'u2', action: 'b', path: '/b', method: 'POST' } as never);
    await log.logEntry({ userId: 'u1', action: 'c', path: '/c', method: 'PUT' } as never);

    const result = await log.getLogs({ userId: 'u1' });
    expect(result.items).toHaveLength(2);
    expect(result.items.every(e => e.userId === 'u1')).toBe(true);
  });

  it('filters by tenantId', async () => {
    const log = createInMemoryAuditLog();

    await log.logEntry({
      userId: 'u1',
      action: 'a',
      path: '/a',
      method: 'GET',
      tenantId: 't1',
    } as never);
    await log.logEntry({
      userId: 'u1',
      action: 'b',
      path: '/b',
      method: 'GET',
      tenantId: 't2',
    } as never);

    const result = await log.getLogs({ tenantId: 't1' });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].tenantId).toBe('t1');
  });

  it('paginates with cursor', async () => {
    const log = createInMemoryAuditLog();

    for (let i = 0; i < 5; i++) {
      await log.logEntry({
        userId: 'u1',
        action: `action_${i}`,
        path: `/path/${i}`,
        method: 'GET',
      } as never);
    }

    const page1 = await log.getLogs({ limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBe('2');

    const page2 = await log.getLogs({ limit: 2, cursor: page1.nextCursor });
    expect(page2.items).toHaveLength(2);
    expect(page2.nextCursor).toBe('4');

    const page3 = await log.getLogs({ limit: 2, cursor: page2.nextCursor });
    expect(page3.items).toHaveLength(1);
    expect(page3.nextCursor).toBeUndefined();
  });

  it('filters by path and method', async () => {
    const log = createInMemoryAuditLog();

    await log.logEntry({ userId: 'u1', action: 'a', path: '/admin/users', method: 'GET' } as never);
    await log.logEntry({
      userId: 'u1',
      action: 'b',
      path: '/admin/users',
      method: 'DELETE',
    } as never);
    await log.logEntry({ userId: 'u1', action: 'c', path: '/admin/roles', method: 'GET' } as never);

    const byPath = await log.getLogs({ path: '/admin/users' });
    expect(byPath.items).toHaveLength(2);

    const byMethod = await log.getLogs({ method: 'DELETE' });
    expect(byMethod.items).toHaveLength(1);
  });

  it('returns empty items when no entries match', async () => {
    const log = createInMemoryAuditLog();
    const result = await log.getLogs({ userId: 'nonexistent' });
    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeUndefined();
  });
});
