import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import type { OperationConfig, ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import {
  defineEntityExecutor,
  defineEntityRoute,
  normalizeEntityRouteShape,
  planEntityRoutes,
  scoreEntityRouteSpecificity,
} from '../../src/routing';

const noteConfig: ResolvedEntityConfig = {
  name: 'Note',
  fields: {
    id: { type: 'string', primary: true, immutable: true, optional: false, default: 'uuid' },
    text: { type: 'string', primary: false, immutable: false, optional: false },
  },
  _pkField: 'id',
  _storageName: 'notes',
  routes: {},
};

describe('entity route planning', () => {
  it('normalizes dynamic path params to the same effective route shape', () => {
    expect(normalizeEntityRouteShape('/notes/:id')).toBe(normalizeEntityRouteShape('/notes/:slug'));
    expect(normalizeEntityRouteShape('/notes/tree')).not.toBe(
      normalizeEntityRouteShape('/notes/:id'),
    );
  });

  it('scores static routes ahead of dynamic routes', () => {
    expect(scoreEntityRouteSpecificity('/notes/tree')).toBeGreaterThan(
      scoreEntityRouteSpecificity('/notes/:id'),
    );
  });

  it('rejects extra routes that collide with generated CRUD routes', () => {
    expect(() =>
      planEntityRoutes(noteConfig, undefined, {
        extraRoutes: [
          defineEntityRoute({
            method: 'get',
            path: '/:slug',
            buildExecutor: () => async exec => exec.respond.json({ ok: true }),
          }),
        ],
      }),
    ).toThrow('Use overrides.get instead');
  });

  it('sorts static extra routes ahead of generated dynamic routes within a method', () => {
    const routes = planEntityRoutes(noteConfig, undefined, {
      extraRoutes: [
        defineEntityRoute({
          method: 'get',
          path: '/tree',
          buildExecutor: () => async exec => exec.respond.json({ ok: true }),
        }),
      ],
    });

    const getRoutes = routes.filter(route => route.method === 'get');
    expect(getRoutes[0]?.path).toBe('/notes/tree');
    expect(getRoutes[1]?.path).toBe('/notes');
    expect(getRoutes[2]?.path).toBe('/notes/:id');
  });

  it('applies generated route overrides without creating duplicate routes', () => {
    const operations: Record<string, OperationConfig> = {
      archive: {
        kind: 'transition',
        input: {},
        output: 'entity',
      } as unknown as OperationConfig,
    };

    const routes = planEntityRoutes(noteConfig, operations, {
      overrides: {
        get: defineEntityExecutor(() => async exec => exec.respond.json(exec.existingRecord ?? {})),
        operations: {
          archive: defineEntityExecutor(() => async exec => exec.respond.json(exec.input)),
        },
      },
    });

    expect(routes.filter(route => route.generatedRouteKey === 'get')).toHaveLength(1);
    expect(routes.filter(route => route.generatedRouteKey === 'operations.archive')).toHaveLength(
      1,
    );
    expect(routes.find(route => route.generatedRouteKey === 'get')?.buildExecutor).toBeDefined();
    expect(
      routes.find(route => route.generatedRouteKey === 'operations.archive')?.buildExecutor,
    ).toBeDefined();
  });

  it('threads override request and response metadata into planned generated routes', () => {
    const routes = planEntityRoutes(noteConfig, undefined, {
      overrides: {
        get: defineEntityExecutor({
          summary: 'Get note with package metadata',
          request: {
            params: z.object({ id: z.string().min(1) }),
          },
          responses: {
            200: {
              description: 'Resolved note',
              schema: z.object({ id: z.string(), text: z.string() }),
            },
          },
          build: () => async exec => exec.respond.json(exec.existingRecord ?? {}),
        }),
      },
    });

    const getRoute = routes.find(route => route.generatedRouteKey === 'get');
    expect(getRoute?.summary).toBe('Get note with package metadata');
    expect(getRoute?.request?.params).toBeDefined();
    expect(getRoute?.responses?.[200]?.description).toBe('Resolved note');
  });
});
