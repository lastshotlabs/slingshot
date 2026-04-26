/**
 * Unit tests for resolveRequestActor.
 *
 * Covers: null resolver short-circuits to ANONYMOUS_ACTOR, resolver.resolveActor is called
 * with the request, and the resolved Actor is returned verbatim.
 */
import { describe, expect, mock, test } from 'bun:test';
import { ANONYMOUS_ACTOR, type Actor } from '@lastshotlabs/slingshot-core';
import { resolveRequestActor } from '../../src/framework/lib/resolveRequestActor';

const userActor: Actor = { ...ANONYMOUS_ACTOR, id: 'user-abc', kind: 'user' };

describe('resolveRequestActor', () => {
  test('returns ANONYMOUS_ACTOR when resolver is null', async () => {
    const req = new Request('http://example.com');
    const result = await resolveRequestActor(req, null);
    expect(result).toBe(ANONYMOUS_ACTOR);
  });

  test('calls resolver.resolveActor with the request', async () => {
    const req = new Request('http://example.com');
    const resolveActorMock = mock(async () => userActor);
    const resolver = { resolveActor: resolveActorMock };
    await resolveRequestActor(req, resolver);
    expect(resolveActorMock).toHaveBeenCalledWith(req);
  });

  test('returns the actor from the resolver', async () => {
    const req = new Request('http://example.com');
    const resolver = { resolveActor: mock(async () => userActor) };
    const result = await resolveRequestActor(req, resolver);
    expect(result).toBe(userActor);
  });

  test('returns ANONYMOUS_ACTOR when resolver returns ANONYMOUS_ACTOR', async () => {
    const req = new Request('http://example.com');
    const resolver = { resolveActor: mock(async () => ANONYMOUS_ACTOR) };
    const result = await resolveRequestActor(req, resolver);
    expect(result).toBe(ANONYMOUS_ACTOR);
  });

  test('resolver is called once per invocation', async () => {
    const req = new Request('http://example.com');
    const resolveActorMock = mock(async () => userActor);
    const resolver = { resolveActor: resolveActorMock };
    await resolveRequestActor(req, resolver);
    await resolveRequestActor(req, resolver);
    expect(resolveActorMock).toHaveBeenCalledTimes(2);
  });
});
