import { describe, expect, it } from 'bun:test';
import {
  deepMerge,
  resolveOverride,
} from '../../../packages/slingshot-infra/src/override/resolveOverrides';
import type { GeneratedFile } from '../../../packages/slingshot-infra/src/types/preset';

describe('deepMerge', () => {
  it('merges flat objects', () => {
    const result = deepMerge({ a: 1, b: 2 }, { b: 3, c: 4 });
    expect(result).toEqual({ a: 1, b: 3, c: 4 });
  });

  it('merges nested objects', () => {
    const result = deepMerge({ a: { x: 1, y: 2 }, b: 3 }, { a: { y: 5, z: 6 } });
    expect(result).toEqual({ a: { x: 1, y: 5, z: 6 }, b: 3 });
  });

  it('replaces arrays instead of merging them', () => {
    const result = deepMerge({ items: [1, 2, 3] }, { items: [4, 5] });
    expect(result).toEqual({ items: [4, 5] });
  });

  it('handles null and undefined in source', () => {
    const source = { a: null, b: undefined } as Record<string, unknown>;
    const result = deepMerge({ a: 1, b: { x: 2 } }, source);
    expect(result.a).toBeNull();
    expect(result.b).toBeUndefined();
  });
});

describe('resolveOverride', () => {
  it('returns generated file unchanged when no override', async () => {
    const generated: GeneratedFile = {
      path: 'Dockerfile',
      content: 'FROM node:20',
      ephemeral: true,
    };
    const result = await resolveOverride(generated, undefined, '/app');
    expect(result).toBe(generated);
  });

  it('merges JSON overrides', async () => {
    const generated: GeneratedFile = {
      path: 'config.json',
      content: JSON.stringify({ name: 'test', settings: { debug: false } }),
      ephemeral: true,
    };
    const result = await resolveOverride(
      generated,
      { settings: { debug: true, verbose: true } },
      '/app',
    );
    const parsed = JSON.parse(result.content);
    expect(parsed.name).toBe('test');
    expect(parsed.settings.debug).toBe(true);
    expect(parsed.settings.verbose).toBe(true);
  });

  it('handles # section-based replacement for text files', async () => {
    const generated: GeneratedFile = {
      path: 'Dockerfile',
      content: [
        '# --- section:base ---',
        'FROM node:20',
        '# --- end:base ---',
        '',
        '# --- section:run ---',
        'CMD ["node", "index.js"]',
        '# --- end:run ---',
      ].join('\n'),
      ephemeral: true,
    };

    const result = await resolveOverride(
      generated,
      { base: 'FROM bun:latest\nWORKDIR /app' },
      '/app',
    );
    expect(result.content).toContain('FROM bun:latest');
    expect(result.content).toContain('WORKDIR /app');
    expect(result.content).not.toContain('FROM node:20');
    expect(result.content).toContain('CMD ["node", "index.js"]');
  });

  it('handles // section-based replacement for TS files', async () => {
    const generated: GeneratedFile = {
      path: 'sst.config.ts',
      content: ['// --- section:vpc ---', 'const vpc = new Vpc();', '// --- end:vpc ---'].join(
        '\n',
      ),
      ephemeral: true,
    };

    const result = await resolveOverride(
      generated,
      { vpc: 'const vpc = new CustomVpc();' },
      '/app',
    );
    expect(result.content).toContain('const vpc = new CustomVpc();');
    expect(result.content).not.toContain('const vpc = new Vpc();');
  });
});
