import { describe, expect, test } from 'bun:test';
import { createPushPlugin } from '../../src/plugin';

describe('createPushPlugin getHealth()', () => {
  test('returns a healthy snapshot with empty providers before setupPost runs', () => {
    const plugin = createPushPlugin({
      enabledPlatforms: ['android'],
      mountPath: '/push',
      android: {
        serviceAccount: {
          project_id: 'test-project',
          client_email: 'firebase@test.iam.gserviceaccount.com',
          private_key: 'k',
        },
      },
    });

    const health = plugin.getHealth();
    expect(health.status).toBe('healthy');
    expect(health.details.providers).toEqual({});
  });
});
