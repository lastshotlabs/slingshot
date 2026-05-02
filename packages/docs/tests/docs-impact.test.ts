import { describe, expect, test } from 'bun:test';
import {
  type DocumentationImpactMap,
  analyzeDocumentationImpact,
  pathMatches,
} from '../docs-impact';

const impactMap: DocumentationImpactMap = {
  surfaces: [
    {
      id: 'app-config',
      codePaths: ['src/defineApp.ts', 'src/app.ts'],
      docPaths: ['packages/docs/src/content/docs/internals/index.mdx'],
    },
    {
      id: 'realtime',
      codePaths: ['src/framework/ws/'],
      docPaths: ['packages/docs/src/content/docs/realtime.mdx'],
    },
  ],
};

describe('pathMatches', () => {
  test('matches exact file paths', () => {
    expect(pathMatches('src/defineApp.ts', 'src/defineApp.ts')).toBe(true);
    expect(pathMatches('src/defineApp.ts', 'src/lib/other.ts')).toBe(false);
  });

  test('matches directory prefixes when pattern ends with slash', () => {
    expect(pathMatches('src/framework/ws/', 'src/framework/ws/rooms.ts')).toBe(true);
    expect(pathMatches('src/framework/ws/', 'src/framework/sse/index.ts')).toBe(false);
  });
});

describe('analyzeDocumentationImpact', () => {
  test('passes when mapped docs are updated for an impacted surface', () => {
    const result = analyzeDocumentationImpact(
      ['src/defineApp.ts', 'packages/docs/src/content/docs/internals/index.mdx'],
      impactMap,
    );

    expect(result.impacted).toHaveLength(1);
    expect(result.failing).toHaveLength(0);
    expect(result.impacted[0]?.surface.id).toBe('app-config');
  });

  test('fails when code changes without the mapped docs update', () => {
    const result = analyzeDocumentationImpact(['src/framework/ws/rooms.ts'], impactMap);

    expect(result.impacted).toHaveLength(1);
    expect(result.failing).toHaveLength(1);
    expect(result.failing[0]?.surface.id).toBe('realtime');
  });

  test('ignores unrelated docs changes when the mapped docs are missing', () => {
    const result = analyzeDocumentationImpact(
      ['src/app.ts', 'packages/docs/src/content/docs/realtime.mdx'],
      impactMap,
    );

    expect(result.failing).toHaveLength(1);
    expect(result.failing[0]?.surface.id).toBe('app-config');
  });
});
