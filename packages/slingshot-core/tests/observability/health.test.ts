import { describe, expect, test } from 'bun:test';
import type {
  HealthCheck,
  HealthReport,
  HealthState,
} from '../../src/observability/health';

describe('HealthCheck contract', () => {
  test('a minimal implementation satisfies the type and returns the cached state', () => {
    const cached: HealthReport = {
      component: 'test-bus',
      state: 'healthy',
      details: { connected: 1 },
    };
    const check: HealthCheck = {
      getHealth: () => cached,
    };
    const report = check.getHealth();
    expect(report.component).toBe('test-bus');
    expect(report.state).toBe('healthy');
    expect(report.details).toEqual({ connected: 1 });
    expect(check.checkHealth).toBeUndefined();
  });

  test('an active probe implementation returns a HealthReport asynchronously', async () => {
    const probe: HealthReport = {
      component: 'test-bus',
      state: 'degraded',
      message: 'lag elevated',
      details: { lagMs: 1200 },
    };
    const check: HealthCheck = {
      getHealth: () => ({ component: 'test-bus', state: 'healthy' }),
      checkHealth: async () => probe,
    };
    expect(check.checkHealth).toBeDefined();
    const report = await check.checkHealth!();
    expect(report.state).toBe('degraded');
    expect(report.message).toBe('lag elevated');
    expect(report.details?.lagMs).toBe(1200);
  });

  test('HealthState union is exactly healthy | degraded | unhealthy', () => {
    const states: HealthState[] = ['healthy', 'degraded', 'unhealthy'];
    expect(states).toEqual(['healthy', 'degraded', 'unhealthy']);
  });
});
