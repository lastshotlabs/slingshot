import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';
import { buildLayoutChain, scanRoutesDirectory } from '../../src/scanner';

function mkRoutes(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'tanstack-scanner-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

const ROUTE = `export const Route = { options: { component: () => null } };\n`;
const SERVER = `export async function load() { return { data: {} }; }\n`;

describe('scanRoutesDirectory', () => {
  it('discovers leaves, layouts, root, and pairs companions', () => {
    const dir = mkRoutes({
      '__root.tsx': ROUTE,
      '_app.tsx': ROUTE,
      '_app/_feed.tsx': ROUTE,
      '_app/_feed/index.tsx': ROUTE,
      '_app/_feed/index.server.ts': SERVER,
      '_app/dm/$userId.tsx': ROUTE,
      '_app/dm/$userId.server.ts': SERVER,
      '_app/dm/index.tsx': ROUTE, // CSR-only — no companion
      '_app/user.$handle.tsx': ROUTE,
      '_app/user.$handle.server.ts': SERVER,
      '_guest.tsx': ROUTE,
      '_guest/auth/login.tsx': ROUTE,
    });

    const { leaves, layouts, rootLayoutPath, rootLayoutServerPath } = scanRoutesDirectory(dir);

    expect(rootLayoutPath).toBe(path.join(dir, '__root.tsx'));
    expect(rootLayoutServerPath).toBeNull();

    expect(layouts.size).toBe(3);
    expect(layouts.get('_app')?.filePath).toBe(path.join(dir, '_app.tsx'));
    expect(layouts.get('_app/_feed')?.filePath).toBe(path.join(dir, '_app/_feed.tsx'));

    // companion-aware leaves: 5 routes, 3 with companions, 2 without
    expect(leaves).toHaveLength(5);
    const companionPairs = leaves.map(l => ({
      url: l.translation.urlPattern,
      hasCompanion: l.serverFilePath !== null,
    }));
    expect(companionPairs).toEqual(
      expect.arrayContaining([
        { url: '/auth/login', hasCompanion: false },
        { url: '/dm', hasCompanion: false },
        { url: '/', hasCompanion: true },
        { url: '/dm/:userId', hasCompanion: true },
        { url: '/user/:handle', hasCompanion: true },
      ]),
    );
  });

  it('orders specific paths before parametrised ones', () => {
    const dir = mkRoutes({
      '$id.tsx': ROUTE,
      '$id.server.ts': SERVER,
      'static.tsx': ROUTE,
      'static.server.ts': SERVER,
    });
    const { leaves } = scanRoutesDirectory(dir);
    expect(leaves[0]?.translation.urlPattern).toBe('/static');
    expect(leaves[1]?.translation.urlPattern).toBe('/:id');
  });

  it('treats `.server.tsx` companions equivalently to `.server.ts`', () => {
    const dir = mkRoutes({
      'a.tsx': ROUTE,
      'a.server.ts': SERVER,
      'b.tsx': ROUTE,
      'b.server.tsx': SERVER,
    });
    const { leaves } = scanRoutesDirectory(dir);
    const a = leaves.find(l => l.relativePath === 'a');
    const b = leaves.find(l => l.relativePath === 'b');
    expect(a?.serverFilePath?.endsWith('a.server.ts')).toBe(true);
    expect(b?.serverFilePath?.endsWith('b.server.tsx')).toBe(true);
  });

  it('does NOT treat companion files as standalone routes', () => {
    const dir = mkRoutes({
      'a.tsx': ROUTE,
      'a.server.ts': SERVER,
    });
    const { leaves } = scanRoutesDirectory(dir);
    expect(leaves).toHaveLength(1);
    expect(leaves[0]?.relativePath).toBe('a');
  });
});

describe('buildLayoutChain', () => {
  it('walks pathless ancestors outermost-first and includes root', () => {
    const dir = mkRoutes({
      '__root.tsx': ROUTE,
      '_app.tsx': ROUTE,
      '_app/_feed.tsx': ROUTE,
      '_app/_feed/index.tsx': ROUTE,
      '_app/_feed/index.server.ts': SERVER,
    });
    const { leaves, layouts, rootLayoutPath, rootLayoutServerPath } = scanRoutesDirectory(dir);
    const leaf = leaves.find(l => l.translation.urlPattern === '/');
    expect(leaf).toBeDefined();
    const chain = buildLayoutChain(leaf!, layouts, rootLayoutPath, rootLayoutServerPath);
    expect(chain.map(l => l.filePath)).toEqual([
      path.join(dir, '__root.tsx'),
      path.join(dir, '_app.tsx'),
      path.join(dir, '_app/_feed.tsx'),
    ]);
  });

  it('forwards layout server-companion paths', () => {
    const dir = mkRoutes({
      '__root.tsx': ROUTE,
      '__root.server.ts': SERVER,
      '_app.tsx': ROUTE,
      '_app/index.tsx': ROUTE,
      '_app/index.server.ts': SERVER,
    });
    const { leaves, layouts, rootLayoutPath, rootLayoutServerPath } = scanRoutesDirectory(dir);
    const leaf = leaves[0];
    expect(leaf).toBeDefined();
    const chain = buildLayoutChain(leaf!, layouts, rootLayoutPath, rootLayoutServerPath);
    expect(chain[0]?.serverFilePath?.endsWith('__root.server.ts')).toBe(true);
    expect(chain[1]?.serverFilePath).toBeNull();
  });
});
