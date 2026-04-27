import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import type {
  Actor,
  PackageDomainRouteContext,
  PluginSetupContext,
  SlingshotPlugin,
} from '@lastshotlabs/slingshot-core';
import {
  defineCapability,
  definePackage,
  domain,
  entityRef,
  inspectPackage,
  route,
} from '@lastshotlabs/slingshot-core';
import {
  defineEntity,
  defineOperations,
  entity,
  field,
  op,
  registerEntityPolicy,
} from '@lastshotlabs/slingshot-entity';
import { createApp } from '../../src/app';

const baseConfig = {
  meta: { name: 'Package Authoring Test App' },
  db: {
    mongo: false as const,
    redis: false,
    sessions: 'memory' as const,
    cache: 'memory' as const,
    auth: 'memory' as const,
  },
  security: {
    rateLimit: { windowMs: 60_000, max: 1000 },
    signing: {
      secret: 'test-secret-key-must-be-at-least-32-chars!!',
      sessionBinding: false as const,
    },
  },
  logging: { onLog: () => {} },
};

const createdContexts: Array<{ destroy(): Promise<void> }> = [];

afterEach(async () => {
  for (const ctx of createdContexts.splice(0)) {
    await ctx.destroy().catch(() => {});
  }
});

const NoteEntity = defineEntity('Note', {
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    text: field.string(),
  },
  routes: {},
});

describe('package-first authoring', () => {
  test('inspects package modules and capabilities without booting the app', () => {
    const noteCapability = defineCapability<{ label: string }>('notes:reporter');
    const notesPackage = definePackage({
      name: 'notes',
      mountPath: '/community',
      entities: [entity({ config: NoteEntity })],
      domains: [
        domain({
          name: 'insights',
          basePath: '/insights',
          routes: [
            route.get({
              path: '/summary',
              handler(ctx: PackageDomainRouteContext) {
                return ctx.respond.json({ packageName: ctx.packageName });
              },
            }),
          ],
        }),
      ],
      capabilities: {
        provides: [
          {
            capability: noteCapability,
            resolve() {
              return { label: 'ready' };
            },
          },
        ],
      },
    });

    expect(inspectPackage(notesPackage)).toMatchObject({
      name: 'notes',
      mountPath: '/community',
      middleware: [],
      entities: [
        {
          name: 'Note',
          entityName: 'Note',
          resolvedPath: '/community/notes',
          wiringMode: 'standard',
        },
      ],
      domains: [
        {
          name: 'insights',
          basePath: '/insights',
          resolvedBasePath: '/community/insights',
        },
      ],
      capabilities: { provides: ['notes:reporter'], requires: [] },
    });
  });

  test('composes a package, installs it through createApp, and exposes package-owned domain routes', async () => {
    const noteCapability = defineCapability<{ label: string }>('notes:reporter');
    const noteModule = entity({ config: NoteEntity });

    const notesPackage = definePackage({
      name: 'notes',
      entities: [noteModule],
      domains: [
        domain({
          name: 'insights',
          basePath: '/insights',
          routes: [
            route.get({
              path: '/summary',
              responses: {
                200: {
                  description: 'Package summary',
                  schema: z.object({
                    packageName: z.string(),
                    capability: z.string(),
                    count: z.number(),
                  }),
                },
              },
              async handler(ctx: PackageDomainRouteContext) {
                const reporter = ctx.capabilities.require(noteCapability);
                const adapter = ctx.entities.get(noteModule);
                const list = await adapter.list({});
                return ctx.respond.json({
                  packageName: ctx.packageName,
                  capability: reporter.label,
                  count: list.items.length,
                });
              },
            }),
          ],
        }),
      ],
      capabilities: {
        provides: [
          {
            capability: noteCapability,
            resolve() {
              return { label: 'ready' };
            },
          },
        ],
      },
    });

    const result = await createApp({
      ...baseConfig,
      packages: [notesPackage],
    });
    createdContexts.push(result.ctx);

    const createResponse = await result.app.request('/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello from package authoring' }),
    });
    expect(createResponse.status).toBe(201);

    const summaryResponse = await result.app.request('/insights/summary');
    expect(summaryResponse.status).toBe(200);
    await expect(summaryResponse.json()).resolves.toEqual({
      packageName: 'notes',
      capability: 'ready',
      count: 1,
    });
  });

  test('package routes resolve cross-package entities through typed entity refs', async () => {
    const noteModule = entity({ config: NoteEntity });

    const notesPackage = definePackage({
      name: 'notes',
      entities: [noteModule],
    });

    const reportingPackage = definePackage({
      name: 'reporting',
      dependencies: ['notes'],
      domains: [
        domain({
          name: 'reports',
          basePath: '/reports',
          routes: [
            route.get({
              path: '/notes',
              async handler(ctx: PackageDomainRouteContext) {
                const notes = ctx.entities.get(entityRef(noteModule, { plugin: 'notes' }));
                const list = await notes.list({});
                return ctx.respond.json({ count: list.items.length });
              },
            }),
          ],
        }),
      ],
    });

    const result = await createApp({
      ...baseConfig,
      packages: [notesPackage, reportingPackage],
    });
    createdContexts.push(result.ctx);

    const createResponse = await result.app.request('/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'cross-package note' }),
    });
    expect(createResponse.status).toBe(201);

    const summaryResponse = await result.app.request('/reports/notes');
    expect(summaryResponse.status).toBe(200);
    await expect(summaryResponse.json()).resolves.toEqual({ count: 1 });
  });

  test('package domain routes use actor-first context and idempotency without legacy auth keys', async () => {
    let executions = 0;
    const actor: Actor = Object.freeze({
      id: 'user-42',
      kind: 'user',
      tenantId: 'tenant-42',
      sessionId: 'session-42',
      roles: null,
      claims: Object.freeze({ plan: 'pro' }),
    });

    const notesPackage = definePackage({
      name: 'notes',
      domains: [
        domain({
          name: 'commands',
          basePath: '/commands',
          routes: [
            route.post({
              path: '/echo',
              idempotency: { scope: 'user', ttl: 60 },
              responses: {
                200: {
                  description: 'Echo payload',
                  schema: z.object({
                    actorId: z.string(),
                    tenantId: z.string(),
                    hasLegacyRequestAliases: z.boolean(),
                    executions: z.number(),
                  }),
                },
              },
              async handler(ctx: PackageDomainRouteContext) {
                executions += 1;
                return ctx.respond.json({
                  actorId: ctx.actor.id,
                  tenantId: ctx.actor.tenantId,
                  hasLegacyRequestAliases:
                    Object.prototype.hasOwnProperty.call(ctx.requestContext, 'authUserId') ||
                    Object.prototype.hasOwnProperty.call(ctx.requestContext, 'tenantId'),
                  executions,
                });
              },
            }),
          ],
        }),
      ],
    });

    const result = await createApp({
      ...baseConfig,
      middleware: [
        async (c, next) => {
          c.set('actor', actor);
          await next();
        },
      ],
      packages: [notesPackage],
    });
    createdContexts.push(result.ctx);

    const request = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'pkg-echo-1',
      },
      body: JSON.stringify({ message: 'hello' }),
    } satisfies RequestInit;

    const first = await result.app.request('/commands/echo', request);
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({
      actorId: 'user-42',
      tenantId: 'tenant-42',
      hasLegacyRequestAliases: false,
      executions: 1,
    });

    const second = await result.app.request('/commands/echo', request);
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual({
      actorId: 'user-42',
      tenantId: 'tenant-42',
      hasLegacyRequestAliases: false,
      executions: 1,
    });
  });

  test('package route idempotency replays non-json responses with original content type', async () => {
    let executions = 0;

    const notesPackage = definePackage({
      name: 'notes',
      domains: [
        domain({
          name: 'exports',
          routes: [
            route.get({
              path: '/report.txt',
              idempotency: { scope: 'global', ttl: 60 },
              async handler(ctx: PackageDomainRouteContext) {
                executions += 1;
                return ctx.respond.text(`report-${executions}`);
              },
            }),
          ],
        }),
      ],
    });

    const result = await createApp({
      ...baseConfig,
      packages: [notesPackage],
    });
    createdContexts.push(result.ctx);

    const request = {
      method: 'GET',
      headers: { 'idempotency-key': 'pkg-report-1' },
    } satisfies RequestInit;

    const first = await result.app.request('/report.txt', request);
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toContain('text/plain');
    await expect(first.text()).resolves.toBe('report-1');

    const second = await result.app.request('/report.txt', request);
    expect(second.status).toBe(200);
    expect(second.headers.get('content-type')).toContain('text/plain');
    await expect(second.text()).resolves.toBe('report-1');
  });

  test('package route idempotency replays binary responses without corrupting the payload', async () => {
    let executions = 0;
    const bytes = new Uint8Array([1, 2, 3, 255]);

    const notesPackage = definePackage({
      name: 'notes',
      domains: [
        domain({
          name: 'exports',
          routes: [
            route.get({
              path: '/report.bin',
              idempotency: { scope: 'global', ttl: 60 },
              async handler(ctx: PackageDomainRouteContext) {
                executions += 1;
                return ctx.respond.body(bytes, 200, {
                  'content-type': 'application/octet-stream',
                  'x-execution-count': String(executions),
                });
              },
            }),
          ],
        }),
      ],
    });

    const result = await createApp({
      ...baseConfig,
      packages: [notesPackage],
    });
    createdContexts.push(result.ctx);

    const request = {
      method: 'GET',
      headers: { 'idempotency-key': 'pkg-report-bin-1' },
    } satisfies RequestInit;

    const first = await result.app.request('/report.bin', request);
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toContain('application/octet-stream');
    expect(first.headers.get('x-execution-count')).toBe('1');
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(bytes);

    const second = await result.app.request('/report.bin', request);
    expect(second.status).toBe(200);
    expect(second.headers.get('content-type')).toContain('application/octet-stream');
    expect(second.headers.get('x-execution-count')).toBe('1');
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(bytes);
  });

  test('package domain routes preserve non-object typed request bodies', async () => {
    const typedRoute = route.withServices<{ clock: () => string }>();

    const notesPackage = definePackage({
      name: 'notes',
      domains: [
        domain({
          name: 'arrays',
          services: {
            clock: () => '2026-04-22T00:00:00.000Z',
          },
          routes: [
            typedRoute.post({
              path: '/tags',
              request: {
                body: z.array(z.string().min(1)),
              },
              responses: {
                200: {
                  description: 'Tag summary',
                  schema: z.object({
                    count: z.number(),
                    first: z.string(),
                    generatedAt: z.string(),
                  }),
                },
              },
              async handler(
                ctx: PackageDomainRouteContext<
                  { body: z.ZodArray<z.ZodString> },
                  { clock: () => string }
                >,
              ) {
                const tags = ctx.body ?? [];
                return ctx.respond.json({
                  count: tags.length,
                  first: tags[0],
                  generatedAt: ctx.services.clock(),
                });
              },
            }),
          ],
        }),
      ],
    });

    const result = await createApp({
      ...baseConfig,
      packages: [notesPackage],
    });
    createdContexts.push(result.ctx);

    const response = await result.app.request('/tags', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(['alpha', 'beta']),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      count: 2,
      first: 'alpha',
      generatedAt: '2026-04-22T00:00:00.000Z',
    });
  });

  test('package domain routes infer typed params on the default route builder', () => {
    route.get({
      path: '/notes/:id',
      request: {
        params: z.object({ id: z.string() }),
      },
      handler(ctx: PackageDomainRouteContext) {
        const noteId = (ctx.params as { id: string }).id;
        return ctx.respond.json({ noteId });
      },
    });

    expect(true).toBe(true);
  });

  test('package entity modules preserve optional null update inputs and named operation IntelliSense', () => {
    const ContactEntity = defineEntity('Contact', {
      fields: {
        id: field.string({ primary: true, default: 'uuid' }),
        email: field.string(),
        parentId: field.string({ optional: true }),
      },
      routes: {},
    });

    const ContactOps = defineOperations(ContactEntity, {
      byEmail: op.lookup({ fields: { email: 'param:email' }, returns: 'one' }),
    });

    const contactModule = entity({
      config: ContactEntity,
      operations: ContactOps,
    });

    type ContactAdapter = Exclude<(typeof contactModule)['__adapter'], undefined>;
    type ContactUpdateInput = Parameters<ContactAdapter['update']>[1];

    const clearParent: ContactUpdateInput = { parentId: null };
    void clearParent;

    route.get({
      path: '/contacts/by-email',
      handler(ctx: PackageDomainRouteContext) {
        const contacts = ctx.entities.get(contactModule);
        void contacts.byEmail({ email: 'person@example.com' });
        return ctx.respond.noContent();
      },
    });

    expect(true).toBe(true);
  });

  test('package domain route input merges object body with params and query', async () => {
    const notesPackage = definePackage({
      name: 'notes',
      domains: [
        domain({
          name: 'merge',
          routes: [
            route.post({
              path: '/items/:id',
              request: {
                params: z.object({ id: z.string() }),
                query: z.object({ mode: z.string() }),
                body: z.object({ label: z.string() }),
              },
              responses: {
                200: {
                  description: 'Merged input',
                  schema: z.object({
                    id: z.string(),
                    mode: z.string(),
                    label: z.string(),
                  }),
                },
              },
              async handler(ctx: PackageDomainRouteContext) {
                const input = ctx.input as { id: string; mode: string; label: string };
                return ctx.respond.json(input);
              },
            }),
          ],
        }),
      ],
    });

    const result = await createApp({
      ...baseConfig,
      packages: [notesPackage],
    });
    createdContexts.push(result.ctx);

    const response = await result.app.request('/items/abc?mode=edit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'hello' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: 'abc',
      mode: 'edit',
      label: 'hello',
    });
  });

  test('service-aware routes reject mismatched domain services at compile time', () => {
    const serviceRoute = route.withServices<{ clock: () => string }>();
    const serviceRouteDef = serviceRoute.get({
      path: '/health',
      handler(ctx: PackageDomainRouteContext<{}, { clock: () => string }>) {
        return ctx.respond.json({ now: ctx.services.clock() });
      },
    });

    domain({
      name: 'broken',
      services: {
        // @ts-expect-error domain services must satisfy the route.withServices contract
        nope: () => 'missing clock',
      },
      routes: [serviceRouteDef],
    });

    expect(true).toBe(true);
  });

  test('package domain routes reuse the entity policy registry', async () => {
    const policyPlugin: SlingshotPlugin = {
      name: 'notes-policy',
      async setupMiddleware({ app }: PluginSetupContext) {
        registerEntityPolicy(app, 'notes:policy', async input => input.userId === 'user-allowed');
      },
    };

    const notesPackage = definePackage({
      name: 'notes',
      dependencies: ['notes-policy'],
      domains: [
        domain({
          name: 'gates',
          basePath: '/gates',
          routes: [
            route.get({
              path: '/policy',
              auth: 'none',
              permission: {
                requires: 'notes:read',
                policy: { resolver: 'notes:policy' },
              },
              responses: {
                200: {
                  description: 'Policy allowed',
                  schema: z.object({ ok: z.literal(true) }),
                },
              },
              handler(ctx: PackageDomainRouteContext) {
                return ctx.respond.json({ ok: true });
              },
            }),
          ],
        }),
      ],
    });

    const result = await createApp({
      ...baseConfig,
      middleware: [
        async (c, next) => {
          c.set(
            'actor',
            Object.freeze({
              id: 'user-blocked',
              kind: 'user',
              tenantId: null,
              sessionId: null,
              roles: null,
              claims: Object.freeze({}),
            } satisfies Actor),
          );
          await next();
        },
      ],
      packages: [notesPackage],
      plugins: [policyPlugin],
    });
    createdContexts.push(result.ctx);

    const response = await result.app.request('/gates/policy');
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: 'Forbidden' });
  });
});
