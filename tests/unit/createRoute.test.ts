import { getRefId } from '@asteasolutions/zod-to-openapi';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import {
  createRoute,
  maybeAutoRegister,
  registerSchema,
  registerSchemas,
  withSecurity,
} from '@lastshotlabs/slingshot-core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Each test uses a fresh schema object so registry entries don't collide
function schema(label: string) {
  return z.object({ _marker: z.literal(label) });
}

// ---------------------------------------------------------------------------
// registerSchema
// ---------------------------------------------------------------------------

describe('registerSchema', () => {
  it('registers schema and returns it unchanged', () => {
    const s = schema('registerSchema-basic');
    const result = registerSchema('RegisterSchemaBasic', s);
    expect(result).toBe(s);
    expect(getRefId(result as any)).toBe('RegisterSchemaBasic');
  });

  it('does not overwrite an already-registered schema', () => {
    const s = schema('registerSchema-no-overwrite');
    registerSchema('RegisterSchemaNoOverwrite', s);
    registerSchema('RegisterSchemaNoOverwrite-second', s); // second call should be a no-op
    // refId is still the first registered name
    expect(getRefId(s as any)).toBe('RegisterSchemaNoOverwrite');
  });
});

// ---------------------------------------------------------------------------
// registerSchemas
// ---------------------------------------------------------------------------

describe('registerSchemas', () => {
  it('registers all schemas and returns the same object', () => {
    const sA = schema('batch-A');
    const sB = schema('batch-B');
    const result = registerSchemas({ BatchA: sA, BatchB: sB });
    expect(result).toMatchObject({ BatchA: sA, BatchB: sB });
    expect(getRefId(sA as any)).toBe('BatchA');
    expect(getRefId(sB as any)).toBe('BatchB');
  });

  it('skips schemas already registered', () => {
    const s = schema('batch-already-registered');
    registerSchema('BatchAlreadyRegistered', s);
    registerSchemas({ BatchAlreadyRegisteredOther: s }); // should be skipped
    expect(getRefId(s as any)).toBe('BatchAlreadyRegistered');
  });
});

// ---------------------------------------------------------------------------
// createRoute — auto-naming conventions
// ---------------------------------------------------------------------------

describe('createRoute — request body auto-naming', () => {
  it('POST /ledger-items → CreateLedgerItemsRequest', () => {
    const body = schema('create-ledger-body');
    createRoute({
      method: 'post',
      path: '/ledger-items',
      request: { body: { content: { 'application/json': { schema: body } } } },
      responses: {},
    });
    expect(getRefId(body as any)).toBe('CreateLedgerItemsRequest');
  });

  it('PATCH /users/{id} → UpdateUsersByIdRequest', () => {
    const body = schema('patch-users-body');
    createRoute({
      method: 'patch',
      path: '/users/{id}',
      request: { body: { content: { 'application/json': { schema: body } } } },
      responses: {},
    });
    expect(getRefId(body as any)).toBe('UpdateUsersByIdRequest');
  });

  it('PUT /items/{id} → ReplaceItemsByIdRequest', () => {
    const body = schema('put-items-body');
    createRoute({
      method: 'put',
      path: '/items/{id}',
      request: { body: { content: { 'application/json': { schema: body } } } },
      responses: {},
    });
    expect(getRefId(body as any)).toBe('ReplaceItemsByIdRequest');
  });
});

describe('createRoute — response auto-naming', () => {
  it('POST /orders 200 → CreateOrdersResponse', () => {
    const res200 = schema('create-orders-200');
    createRoute({
      method: 'post',
      path: '/orders',
      responses: {
        200: { content: { 'application/json': { schema: res200 } }, description: 'ok' },
      },
    });
    expect(getRefId(res200 as any)).toBe('CreateOrdersResponse');
  });

  it('POST /orders 201 → CreateOrdersResponse', () => {
    const res201 = schema('create-orders-201');
    createRoute({
      method: 'post',
      path: '/orders',
      responses: {
        201: { content: { 'application/json': { schema: res201 } }, description: 'created' },
      },
    });
    expect(getRefId(res201 as any)).toBe('CreateOrdersResponse');
  });

  it('GET /items 200 → GetItemsResponse', () => {
    const res = schema('get-items-200');
    createRoute({
      method: 'get',
      path: '/items',
      responses: { 200: { content: { 'application/json': { schema: res } }, description: 'ok' } },
    });
    expect(getRefId(res as any)).toBe('GetItemsResponse');
  });

  it('DELETE /things 204 → DeleteThingsResponse', () => {
    const res = schema('delete-things-204');
    createRoute({
      method: 'delete',
      path: '/things',
      responses: { 204: { content: { 'application/json': { schema: res } }, description: 'ok' } },
    });
    expect(getRefId(res as any)).toBe('DeleteThingsResponse');
  });

  it('PATCH /users/{id} 400 → UpdateUsersByIdBadRequestError', () => {
    const err = schema('patch-users-400');
    createRoute({
      method: 'patch',
      path: '/users/{id}',
      responses: { 400: { content: { 'application/json': { schema: err } }, description: 'bad' } },
    });
    expect(getRefId(err as any)).toBe('UpdateUsersByIdBadRequestError');
  });

  it('GET /things 401 → GetThingsUnauthorizedError', () => {
    const err = schema('get-things-401');
    createRoute({
      method: 'get',
      path: '/things',
      responses: {
        401: { content: { 'application/json': { schema: err } }, description: 'unauth' },
      },
    });
    expect(getRefId(err as any)).toBe('GetThingsUnauthorizedError');
  });

  it('GET /things 404 → GetThingsNotFoundError', () => {
    const err = schema('get-things-404');
    createRoute({
      method: 'get',
      path: '/things',
      responses: {
        404: { content: { 'application/json': { schema: err } }, description: 'not found' },
      },
    });
    expect(getRefId(err as any)).toBe('GetThingsNotFoundError');
  });

  it('POST /things 409 → CreateThingsConflictError', () => {
    const err = schema('post-things-409');
    createRoute({
      method: 'post',
      path: '/things',
      responses: {
        409: { content: { 'application/json': { schema: err } }, description: 'conflict' },
      },
    });
    expect(getRefId(err as any)).toBe('CreateThingsConflictError');
  });

  it('GET /things 500 → GetThingsInternalError', () => {
    const err = schema('get-things-500');
    createRoute({
      method: 'get',
      path: '/things',
      responses: { 500: { content: { 'application/json': { schema: err } }, description: 'err' } },
    });
    expect(getRefId(err as any)).toBe('GetThingsInternalError');
  });

  it('unknown status code falls back to numeric suffix', () => {
    const res = schema('get-things-418');
    createRoute({
      method: 'get',
      path: '/things',
      responses: {
        418: { content: { 'application/json': { schema: res } }, description: 'teapot' },
      },
    });
    expect(getRefId(res as any)).toBe('GetThings418');
  });
});

describe('createRoute — path segment PascalCase conversion', () => {
  it('kebab-case segments → PascalCase', () => {
    const res = schema('get-ledger-items-200');
    createRoute({
      method: 'get',
      path: '/ledger-items',
      responses: { 200: { content: { 'application/json': { schema: res } }, description: 'ok' } },
    });
    expect(getRefId(res as any)).toBe('GetLedgerItemsResponse');
  });

  it('path param segment → ByParam PascalCase', () => {
    const res = schema('get-sessions-by-id');
    createRoute({
      method: 'get',
      path: '/auth/sessions/{sessionId}',
      responses: { 200: { content: { 'application/json': { schema: res } }, description: 'ok' } },
    });
    expect(getRefId(res as any)).toBe('GetAuthSessionsBySessionIdResponse');
  });
});

describe('createRoute — skips already-named schemas', () => {
  it('does not overwrite a schema already registered via registerSchema', () => {
    const s = schema('pre-registered-response');
    registerSchema('PreRegisteredResponse', s);
    createRoute({
      method: 'get',
      path: '/pre-registered',
      responses: { 200: { content: { 'application/json': { schema: s } }, description: 'ok' } },
    });
    // Name should still be the one set by registerSchema
    expect(getRefId(s as any)).toBe('PreRegisteredResponse');
  });
});

// ---------------------------------------------------------------------------
// withSecurity
// ---------------------------------------------------------------------------

describe('withSecurity', () => {
  it('adds security schemes to a route object', () => {
    const route = createRoute({
      method: 'get',
      path: '/secure',
      responses: { 200: { description: 'ok' } },
    });
    const secured = withSecurity(route, { cookieAuth: [] }, { userToken: [] });
    expect((secured as any).security).toEqual([{ cookieAuth: [] }, { userToken: [] }]);
  });

  it('returns the same route object (mutates and returns)', () => {
    const route = createRoute({
      method: 'get',
      path: '/secure2',
      responses: { 200: { description: 'ok' } },
    });
    const secured = withSecurity(route, { bearerAuth: [] });
    expect(secured).toBe(route);
  });
});

// ---------------------------------------------------------------------------
// maybeAutoRegister
// ---------------------------------------------------------------------------

describe('maybeAutoRegister', () => {
  it('skips non-object values', () => {
    maybeAutoRegister('Foo', null);
    maybeAutoRegister('Bar', 'string');
    maybeAutoRegister('Baz', 42);
    // No error thrown = success
  });

  it('skips values without _def (not Zod schemas)', () => {
    maybeAutoRegister('Foo', { notAZodSchema: true });
    // No error thrown = success
  });

  it('registers a Zod schema with name', () => {
    const s = z.object({ x: z.number() });
    maybeAutoRegister('TestAutoReg', s);
    expect(getRefId(s as any)).toBe('TestAutoReg');
  });

  it('strips Schema suffix from export name', () => {
    const s = z.object({ y: z.string() });
    maybeAutoRegister('WidgetSchema', s);
    expect(getRefId(s as any)).toBe('Widget');
  });

  it('skips already registered schemas', () => {
    const s = z.object({ z: z.boolean() }).openapi('AlreadyRegistered');
    maybeAutoRegister('AlreadyRegistered', s);
    // refId should still be the original
    expect(getRefId(s as any)).toBe('AlreadyRegistered');
  });
});
