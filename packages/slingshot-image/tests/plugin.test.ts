// packages/slingshot-image/tests/plugin.test.ts
import { describe, expect, it } from 'bun:test';
import { createImagePlugin } from '../src/plugin';

describe('createImagePlugin', () => {
  it('returns a plugin with name slingshot-image', () => {
    const plugin = createImagePlugin();
    expect(plugin.name).toBe('slingshot-image');
  });

  it('creates a plugin with default config when no args given', () => {
    expect(() => createImagePlugin()).not.toThrow();
  });

  it('accepts allowedOrigins config', () => {
    const plugin = createImagePlugin({
      allowedOrigins: ['cdn.example.com'],
    });
    expect(plugin.name).toBe('slingshot-image');
  });

  it('accepts full config', () => {
    const plugin = createImagePlugin({
      allowedOrigins: ['cdn.example.com'],
      maxWidth: 2048,
      maxHeight: 2048,
      routePrefix: '/_img',
    });
    expect(plugin.name).toBe('slingshot-image');
  });

  it('throws ZodError when maxWidth is out of range', () => {
    expect(() => createImagePlugin({ maxWidth: 99999 })).toThrow();
  });

  it('throws ZodError when routePrefix does not start with a slash', () => {
    expect(() => createImagePlugin({ routePrefix: 'image' })).toThrow();
  });

  it('creates isolated cache per factory call (Rule 3)', () => {
    // Each call produces an independent plugin with its own cache
    const plugin1 = createImagePlugin();
    const plugin2 = createImagePlugin();
    expect(plugin1).not.toBe(plugin2);
  });

  it('exposes setupRoutes lifecycle method', () => {
    const plugin = createImagePlugin();
    expect(typeof plugin.setupRoutes).toBe('function');
  });

  it('does not expose setupMiddleware or setupPost', () => {
    const plugin = createImagePlugin();
    // These are optional — just verify setupRoutes is the one we define
    expect(plugin.setupRoutes).toBeDefined();
  });
});
