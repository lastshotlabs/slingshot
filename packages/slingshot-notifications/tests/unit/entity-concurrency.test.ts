import { describe, expect, it } from 'bun:test';
import { createMemoryEntityAdapter } from '@lastshotlabs/slingshot-entity';
import { NotificationPreference } from '../../src/entities/preference';

describe('notification preference optimistic concurrency', () => {
  it('adopts optional guarded writes without breaking internal unconditional updates', async () => {
    expect(NotificationPreference._concurrency).toEqual({
      strategy: 'version',
      field: 'version',
      initialVersion: 1,
      requiredOnWrite: false,
    });

    const adapter = createMemoryEntityAdapter<
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>
    >(NotificationPreference);
    const created = await adapter.create({
      id: 'preference-1',
      userId: 'user-1',
      scope: 'global',
    });
    expect(created['version']).toBe(1);

    const unconditional = await adapter.update('preference-1', { muted: true });
    expect(unconditional?.['version']).toBe(2);

    const guarded = await adapter.update('preference-1', { emailEnabled: false }, undefined, {
      expectedVersion: 2,
    });
    expect(guarded?.['version']).toBe(3);
  });
});
