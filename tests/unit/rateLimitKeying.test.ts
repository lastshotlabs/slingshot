/**
 * The global rate limiter must key by CLIENT, not by IP.
 *
 * The bug this pins: a party game is N phones in one living room behind one home
 * NAT. They all present the same public IP. Keyed by IP, six players + a TV + the
 * host share ONE bucket, so the room's request budget is divided by the number of
 * guests — and live gameplay is chatty by design. The failure mode is a flat 429
 * mid-game, and it gets worse the better the party goes.
 */
import { describe, expect, test } from 'bun:test';
import { ANONYMOUS_ACTOR, type Actor } from '@lastshotlabs/slingshot-core';
import { createApp } from '../../src/app';

const WINDOW = { windowMs: 60_000, max: 5 };
const ONE_IP = '203.0.113.7'; // the household's public IP

/**
 * Build an app whose actor is whatever the test says it is, at one shared IP.
 *
 * The actor is published from a **plugin's `setupMiddleware`**, which is exactly
 * where the auth plugin publishes it — and, crucially, that phase runs BEFORE the
 * rate limiter is mounted. Publishing it from the `middleware:` array instead
 * would run *after* the limiter and the actor would be invisible to it, which is
 * precisely the ordering bug this whole change had to fix. So the test has to be
 * wired the way production is, or it proves nothing.
 */
async function appWithActor(actorFor: (req: Request) => Actor) {
  const { app } = await createApp({
    meta: { name: 'rl-test', version: '0.0.0' },
    db: { mongo: false, redis: false },
    security: {
      signing: { secret: 'test-secret-test-secret-test-secret', sessionBinding: false },
      rateLimit: WINDOW,
      trustProxy: 1,
    },
    plugins: [
      {
        name: 'test-identity',
        setupMiddleware({ app: honoApp }: { app: { use: (mw: unknown) => void } }) {
          honoApp.use(
            async (
              c: { set: (k: string, v: unknown) => void; req: { raw: Request } },
              next: () => Promise<void>,
            ) => {
              c.set('actor', actorFor(c.req.raw));
              await next();
            },
          );
        },
        setupRoutes({ app: honoApp }: { app: { get: (p: string, h: unknown) => void } }) {
          honoApp.get('/ping', (c: { json: (b: unknown) => unknown }) => c.json({ ok: true }));
        },
      } as never,
    ],
  });

  return app;
}

function req(userId: string | null) {
  return new Request('http://localhost/ping', {
    headers: {
      'x-forwarded-for': ONE_IP,
      ...(userId ? { 'x-test-user': userId } : {}),
    },
  });
}

function userActor(id: string): Actor {
  return { id, kind: 'user', tenantId: null, sessionId: null, roles: ['user'], claims: {} };
}

function displayActor(sessionId: string, tokenId: string): Actor {
  return {
    id: null,
    kind: 'display',
    tenantId: null,
    sessionId: null,
    roles: null,
    claims: { displaySessionId: sessionId, displayTokenId: tokenId },
  };
}

describe('rate limiting keys by client, not by IP', () => {
  test('SIX PHONES AT ONE PARTY: same IP, distinct sessions, nobody is throttled', async () => {
    const app = await appWithActor(r => {
      const id = r.headers.get('x-test-user');
      return id ? userActor(id) : ANONYMOUS_ACTOR;
    });

    // Every player spends their FULL budget. Under IP keying, player 2 would
    // already be 429ing — the room shares one bucket.
    for (const player of ['ana', 'ben', 'carla', 'dev', 'eve', 'frank']) {
      for (let i = 0; i < WINDOW.max; i++) {
        const res = await app.request(req(player));
        expect(res.status).toBe(200);
      }
    }
  });

  test('one client over its own budget IS throttled', async () => {
    const app = await appWithActor(() => userActor('ana'));

    for (let i = 0; i < WINDOW.max; i++) {
      expect((await app.request(req('ana'))).status).toBe(200);
    }
    expect((await app.request(req('ana'))).status).toBe(429);
  });

  test('an ANONYMOUS flood from one IP is still limited (IP is right when it is all we have)', async () => {
    const app = await appWithActor(() => ANONYMOUS_ACTOR);

    for (let i = 0; i < WINDOW.max; i++) {
      expect((await app.request(req(null))).status).toBe(200);
    }
    expect((await app.request(req(null))).status).toBe(429);
  });

  test('a TV gets its OWN bucket — it cannot eat the room’s budget, nor be starved by it', async () => {
    let mode: 'tv' | 'player' = 'tv';
    const app = await appWithActor(() =>
      mode === 'tv' ? displayActor('session-1', 'tok-1') : userActor('ana'),
    );

    // The TV polls itself to exhaustion.
    for (let i = 0; i < WINDOW.max; i++) {
      expect((await app.request(req(null))).status).toBe(200);
    }
    expect((await app.request(req(null))).status).toBe(429);

    // A player at the same IP is completely unaffected.
    mode = 'player';
    expect((await app.request(req('ana'))).status).toBe(200);
  });

  test('two TVs on the same session are separate clients', async () => {
    let token = 'tok-1';
    const app = await appWithActor(() => displayActor('session-1', token));

    for (let i = 0; i < WINDOW.max; i++) {
      expect((await app.request(req(null))).status).toBe(200);
    }
    expect((await app.request(req(null))).status).toBe(429);

    token = 'tok-2';
    expect((await app.request(req(null))).status).toBe(200);
  });
});
