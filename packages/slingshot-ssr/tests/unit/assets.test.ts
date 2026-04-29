import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SsrAssetManifestError,
  buildDevAssetTags,
  readAssetManifest,
  resolveAssetTags,
} from '../../src/assets';

describe('readAssetManifest', () => {
  test('parses a valid manifest file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ssr-assets-'));
    const manifestPath = join(dir, 'manifest.json');
    const manifest = {
      'index.html': { file: 'assets/index-abc123.js', css: ['assets/index-abc123.css'], isEntry: true },
    };
    writeFileSync(manifestPath, JSON.stringify(manifest));
    try {
      const result = readAssetManifest(manifestPath);
      expect(result['index.html']?.file).toBe('assets/index-abc123.js');
      expect(result['index.html']?.css).toEqual(['assets/index-abc123.css']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('throws SsrAssetManifestError when file is missing', () => {
    expect(() => readAssetManifest('/nonexistent/path/manifest.json')).toThrow(SsrAssetManifestError);
  });

  test('throws SsrAssetManifestError for invalid JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ssr-assets-'));
    const manifestPath = join(dir, 'manifest.json');
    writeFileSync(manifestPath, 'not json');
    try {
      expect(() => readAssetManifest(manifestPath)).toThrow(SsrAssetManifestError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveAssetTags', () => {
  const baseManifest = {
    'index.html': {
      file: 'assets/index-abc123.js',
      css: ['assets/index-abc123.css'],
      isEntry: true,
    },
  };

  test('returns script and css link tags for a valid entry', () => {
    const tags = resolveAssetTags(baseManifest, 'index.html');
    expect(tags).toContain('<script type="module" src="/assets/index-abc123.js"></script>');
    expect(tags).toContain('<link rel="stylesheet" href="/assets/index-abc123.css">');
  });

  test('css links appear before script tag', () => {
    const tags = resolveAssetTags(baseManifest, 'index.html');
    const cssIndex = tags.indexOf('<link');
    const scriptIndex = tags.indexOf('<script');
    expect(cssIndex).toBeLessThan(scriptIndex);
  });

  test('returns empty string for missing entry', () => {
    expect(resolveAssetTags(baseManifest, 'nonexistent')).toBe('');
  });

  test('returns only script tag when entry has no css', () => {
    const manifest = {
      'app.tsx': { file: 'assets/app-xyz789.js', isEntry: true },
    };
    const tags = resolveAssetTags(manifest, 'app.tsx');
    expect(tags).toContain('<script type="module" src="/assets/app-xyz789.js"></script>');
    expect(tags).not.toContain('<link');
  });

  test('deduplicates css files across imports', () => {
    const manifest = {
      'index.html': {
        file: 'assets/index.js',
        css: ['assets/shared.css'],
        imports: ['chunk-a'],
        isEntry: true,
      },
      'chunk-a': {
        file: 'assets/chunk-a.js',
        css: ['assets/shared.css'],
      },
    };
    const tags = resolveAssetTags(manifest, 'index.html');
    const cssMatches = tags.match(/shared\.css/g);
    expect(cssMatches).toHaveLength(1);
  });

  test('handles nested imports', () => {
    const manifest = {
      'index.html': {
        file: 'assets/index.js',
        imports: ['chunk-a'],
        isEntry: true,
      },
      'chunk-a': {
        file: 'assets/chunk-a.js',
        css: ['assets/chunk-a.css'],
        imports: ['chunk-b'],
      },
      'chunk-b': {
        file: 'assets/chunk-b.js',
        css: ['assets/chunk-b.css'],
      },
    };
    const tags = resolveAssetTags(manifest, 'index.html');
    expect(tags).toContain('chunk-a.css');
    expect(tags).toContain('chunk-b.css');
  });

  test('handles circular imports gracefully', () => {
    const manifest: Record<string, { file: string; css?: string[]; imports?: string[]; isEntry?: boolean }> = {
      'index.html': {
        file: 'assets/index.js',
        imports: ['chunk-a'],
        isEntry: true,
      },
      'chunk-a': {
        file: 'assets/chunk-a.js',
        imports: ['chunk-b'],
      },
      'chunk-b': {
        file: 'assets/chunk-b.js',
        imports: ['chunk-a'],
      },
    };
    const tags = resolveAssetTags(manifest, 'index.html');
    expect(tags).toContain('<script');
  });

  test('returns empty string for empty manifest', () => {
    expect(resolveAssetTags({}, 'index.html')).toBe('');
  });
});

describe('buildDevAssetTags', () => {
  test('includes vite client and default entry module', () => {
    const tags = buildDevAssetTags();
    expect(tags).toContain('<script type="module" src="/@vite/client"></script>');
    expect(tags).toContain('<script type="module" src="/src/main.tsx"></script>');
  });

  test('uses custom entry module', () => {
    const tags = buildDevAssetTags('/src/entry.tsx');
    expect(tags).toContain('<script type="module" src="/src/entry.tsx"></script>');
    expect(tags).not.toContain('/src/main.tsx');
  });
});
