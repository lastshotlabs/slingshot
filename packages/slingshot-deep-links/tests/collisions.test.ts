/**
 * Tests for warnOnPathCollisions.
 */
import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { warnOnPathCollisions } from '../src/collisions';
import type { DeepLinksConfig } from '../src/config';

const appleConfig: DeepLinksConfig = Object.freeze({
  apple: Object.freeze([
    Object.freeze({
      teamId: 'TEAM123456',
      bundleId: 'com.example.app',
      paths: Object.freeze(['/share/*', '/posts/*']),
    }),
  ]),
});

function makeApp(...routePaths: string[]): Hono {
  const app = new Hono();
  for (const path of routePaths) {
    app.get(path, c => c.text('ok'));
  }
  return app;
}

describe('warnOnPathCollisions', () => {
  test('logs a warning when AASA path collides with a registered route', () => {
    const app = makeApp('/share/:id', '/posts/:postId');
    const warns: unknown[][] = [];
    const logger = {
      warn: (...args: unknown[]) => {
        warns.push(args);
      },
    };

    warnOnPathCollisions(app, appleConfig, logger);

    expect(warns.length).toBeGreaterThan(0);
  });

  test('does not warn when no routes overlap with AASA paths', () => {
    const app = makeApp('/api/users', '/api/messages');
    const warns: unknown[][] = [];
    const logger = {
      warn: (...args: unknown[]) => {
        warns.push(args);
      },
    };

    warnOnPathCollisions(app, appleConfig, logger);

    expect(warns).toHaveLength(0);
  });

  test('does not warn when apple config is absent', () => {
    const config: DeepLinksConfig = Object.freeze({
      android: Object.freeze({ packageName: 'com.x', sha256Fingerprints: [] }),
    });
    const app = makeApp('/share/:id');
    const warns: unknown[][] = [];
    const logger = {
      warn: (...args: unknown[]) => {
        warns.push(args);
      },
    };

    warnOnPathCollisions(app, config, logger);

    expect(warns).toHaveLength(0);
  });

  test('does not warn on its own well-known paths', () => {
    const app = makeApp('/.well-known/apple-app-site-association', '/.well-known/assetlinks.json');
    const warns: unknown[][] = [];
    const logger = {
      warn: (...args: unknown[]) => {
        warns.push(args);
      },
    };

    warnOnPathCollisions(app, appleConfig, logger);

    expect(warns).toHaveLength(0);
  });

  test('handles null logger gracefully', () => {
    const app = makeApp('/share/:id');
    expect(() => warnOnPathCollisions(app, appleConfig, null)).not.toThrow();
  });
});
