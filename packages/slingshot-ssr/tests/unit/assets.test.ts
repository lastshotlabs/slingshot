import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  SsrAssetManifestError,
  buildDevAssetTags,
  readAssetManifest,
  resolveAssetTags,
} from '../../src/assets';

const TMP = join(import.meta.dir, '__tmp_manifest__');
const MANIFEST_PATH = join(TMP, 'manifest.json');

const SAMPLE_MANIFEST = {
  'index.html': {
    file: 'assets/index-B3xk9aJi.js',
    css: ['assets/index-CyBwkqGn.css'],
    isEntry: true,
  },
};

const MANIFEST_WITH_CHUNKS = {
  'index.html': {
    file: 'assets/index-B3xk9aJi.js',
    css: ['assets/index-CyBwkqGn.css'],
    isEntry: true,
    imports: ['_chunk-A.js'],
  },
  '_chunk-A.js': {
    file: 'assets/chunk-A-Xyz123.js',
    css: ['assets/chunk-A-Abc456.css'],
  },
};

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('readAssetManifest', () => {
  it('parses valid manifest file', () => {
    writeFileSync(MANIFEST_PATH, JSON.stringify(SAMPLE_MANIFEST));
    const manifest = readAssetManifest(MANIFEST_PATH);
    expect(manifest['index.html'].file).toBe('assets/index-B3xk9aJi.js');
  });

  it('throws SsrAssetManifestError for missing file', () => {
    expect(() => readAssetManifest('/nonexistent/path/manifest.json')).toThrow(
      SsrAssetManifestError,
    );
  });

  it('throws SsrAssetManifestError for invalid JSON', () => {
    writeFileSync(MANIFEST_PATH, 'not valid json {{{');
    expect(() => readAssetManifest(MANIFEST_PATH)).toThrow(SsrAssetManifestError);
  });

  it('SsrAssetManifestError carries manifestPath', () => {
    const badPath = '/nonexistent.json';
    try {
      readAssetManifest(badPath);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SsrAssetManifestError);
      expect((err as SsrAssetManifestError).manifestPath).toBe(badPath);
    }
  });

  it('SsrAssetManifestError.name is SsrAssetManifestError', () => {
    try {
      readAssetManifest('/nonexistent.json');
    } catch (err) {
      expect((err as SsrAssetManifestError).name).toBe('SsrAssetManifestError');
    }
  });
});

describe('resolveAssetTags', () => {
  it('produces <link rel="stylesheet"> for CSS files', () => {
    const tags = resolveAssetTags(SAMPLE_MANIFEST, 'index.html');
    expect(tags).toContain('<link rel="stylesheet" href="/assets/index-CyBwkqGn.css">');
  });

  it('produces <script type="module"> for JS entry', () => {
    const tags = resolveAssetTags(SAMPLE_MANIFEST, 'index.html');
    expect(tags).toContain('<script type="module" src="/assets/index-B3xk9aJi.js">');
  });

  it('returns empty string for unknown entry key', () => {
    expect(resolveAssetTags(SAMPLE_MANIFEST, 'nonexistent.html')).toBe('');
  });

  it('includes CSS from imported chunks', () => {
    const tags = resolveAssetTags(MANIFEST_WITH_CHUNKS, 'index.html');
    expect(tags).toContain('/assets/chunk-A-Abc456.css');
  });

  it('deduplicates CSS files appearing in multiple chunks', () => {
    const manifest = {
      'index.html': {
        file: 'assets/index.js',
        css: ['assets/shared.css'],
        imports: ['_chunk-A.js', '_chunk-B.js'],
      },
      '_chunk-A.js': { file: 'assets/a.js', css: ['assets/shared.css'] },
      '_chunk-B.js': { file: 'assets/b.js', css: ['assets/shared.css'] },
    };
    const tags = resolveAssetTags(manifest, 'index.html');
    const count = (tags.match(/shared\.css/g) ?? []).length;
    expect(count).toBe(1);
  });

  it('handles entry with no CSS', () => {
    const manifest = { 'index.html': { file: 'assets/index.js', isEntry: true } };
    const tags = resolveAssetTags(manifest, 'index.html');
    expect(tags).toContain('<script');
    expect(tags).not.toContain('<link');
  });
});

describe('buildDevAssetTags', () => {
  it('includes Vite client script', () => {
    expect(buildDevAssetTags()).toContain('/@vite/client');
  });

  it('includes default entry module /src/main.tsx', () => {
    expect(buildDevAssetTags()).toContain('/src/main.tsx');
  });

  it('uses custom entry module when provided', () => {
    const tags = buildDevAssetTags('/src/custom-entry.tsx');
    expect(tags).toContain('/src/custom-entry.tsx');
    expect(tags).not.toContain('/src/main.tsx');
  });
});
