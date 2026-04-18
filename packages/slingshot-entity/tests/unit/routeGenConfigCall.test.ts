/**
 * Codegen output assertions: generate() with routes config produces
 * routes.ts and optionally events.ts.
 */
import { describe, expect, it } from 'bun:test';
import { defineEntity, field } from '../../src/defineEntity';
import { generate } from '../../src/generate';

const postEntity = defineEntity('Post', {
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    authorId: field.string(),
    title: field.string(),
    status: field.enum(['draft', 'published', 'deleted'], { default: 'draft' }),
    createdAt: field.date({ default: 'now' }),
  },
  routes: {
    create: { auth: 'userAuth' },
    list: { auth: 'none' },
  },
});

const postEntityWithEvents = defineEntity('Post', {
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    authorId: field.string(),
    title: field.string(),
    status: field.enum(['draft', 'published', 'deleted'], { default: 'draft' }),
    createdAt: field.date({ default: 'now' }),
  },
  routes: {
    create: {
      auth: 'userAuth',
      event: { key: 'post:created', payload: ['title', 'authorId'] },
    },
    delete: { event: 'post:deleted' },
  },
});

describe('generate() with routes config', () => {
  it('produces routes.ts when routes config is set (even without operations)', () => {
    const files = generate(postEntity, { backends: ['memory'] });
    expect('routes.ts' in files).toBe(true);
  });

  it('does not produce events.ts when routes has no events', () => {
    const files = generate(postEntity, { backends: ['memory'] });
    expect('events.ts' in files).toBe(false);
  });

  it('produces events.ts when routes has at least one event', () => {
    const files = generate(postEntityWithEvents, { backends: ['memory'] });
    expect('events.ts' in files).toBe(true);
  });

  it('events.ts contains module augmentation for declared events', () => {
    const files = generate(postEntityWithEvents, { backends: ['memory'] });
    const eventsContent = files['events.ts'];
    expect(eventsContent).toContain("declare module '@lastshotlabs/slingshot-core'");
    expect(eventsContent).toContain("'post:created'");
    expect(eventsContent).toContain("'post:deleted'");
    expect(eventsContent).toContain('title: string');
    expect(eventsContent).toContain('authorId: string');
  });

  it('routes.ts is generated even when only routes config (no explicit operations)', () => {
    const files = generate(postEntity, { backends: ['memory'] });
    const routesContent = files['routes.ts'];
    expect(routesContent).toBeDefined();
    // Should be a valid routes file with the entity-specific CRUD factory function
    expect(routesContent).toContain('createPostRoutes');
  });
});
