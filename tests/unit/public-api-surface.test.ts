/**
 * Public API surface guard.
 *
 * Consumer apps must never reach into framework internals via deep paths
 * (`slingshot/src/...`). Doing so loads the framework a second time, and
 * middleware registered on one module instance silently fails to run for
 * requests routed through the other — that is how `auth: 'userAuth'` stopped
 * being enforced on real deployments.
 *
 * Every symbol an app legitimately needs must therefore be reachable from a
 * declared entrypoint. This test pins the symbols the apps on this platform
 * consume; if one stops being exported, the deep-import regression becomes
 * possible again, so failing here is the intended outcome.
 */
import { describe, expect, test } from 'bun:test';
import * as slingshot from '../../src/index';
import * as testing from '../../src/testing';

// Symbols consumed by trivia/blankslate/hitshot from the root entrypoint.
const ROOT_EXPORTS = [
  // App + server assembly
  'createApp',
  'createServer',
  'defineApp',
  'definePackage',
  'domain',
  'route',
  'entity',
  // Context access — `getContext` from an app, `getServerContext` from a server
  'getContext',
  'getContextOrNull',
  'getServerContext',
  // WebSocket consumer API (room inspection + the key-builder that pairs with it)
  'publish',
  'getRooms',
  'getSubscriptions',
  'getRoomSubscribers',
  'wsEndpointKey',
] as const;

// Symbols consumed from the `./testing` entrypoint by app e2e suites.
const TESTING_EXPORTS = ['createTestFullServer'] as const;

describe('public API surface', () => {
  test.each(ROOT_EXPORTS)('@lastshotlabs/slingshot exports %s', name => {
    expect(slingshot[name as keyof typeof slingshot]).toBeDefined();
  });

  test.each(TESTING_EXPORTS)('@lastshotlabs/slingshot/testing exports %s', name => {
    expect(testing[name as keyof typeof testing]).toBeDefined();
  });
});
