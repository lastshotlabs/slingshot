import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { buildWorkspacePathMappings, extractTypescriptBlocks } from '../typecheck-docs';

const tempDirs: string[] = [];

function createDocFile(content: string): string {
  const tempDir = mkdtempSync(join(tmpdir(), 'slingshot-docs-'));
  tempDirs.push(tempDir);

  const filePath = join(tempDir, 'example.mdx');
  writeFileSync(filePath, content);
  return filePath;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

describe('extractTypescriptBlocks', () => {
  test('extracts blocks with import statements', () => {
    const filePath = createDocFile(`
# Example

\`\`\`ts
import { createApp } from '@lastshotlabs/slingshot';

await createApp({});
\`\`\`
`);

    const blocks = extractTypescriptBlocks(filePath);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.blockIndex).toBe(0);
    expect(blocks[0]?.code).toContain('import { createApp }');
  });

  test('skips blocks without imports', () => {
    const filePath = createDocFile(`
\`\`\`typescript
const value = 1;
\`\`\`
`);

    expect(extractTypescriptBlocks(filePath)).toHaveLength(0);
  });

  test('skips blocks with @skip-typecheck', () => {
    const filePath = createDocFile(`
\`\`\`ts
// @skip-typecheck
import { createApp } from '@lastshotlabs/slingshot';
\`\`\`
`);

    expect(extractTypescriptBlocks(filePath)).toHaveLength(0);
  });

  test('tracks correct source line numbers', () => {
    const filePath = createDocFile(`
line 1
line 2

\`\`\`ts
import { createApp } from '@lastshotlabs/slingshot';
\`\`\`
`);

    const blocks = extractTypescriptBlocks(filePath);
    expect(blocks[0]?.sourceLine).toBe(5);
  });

  test('handles nested fences in MDX', () => {
    const filePath = createDocFile(`
<Tabs>
  <TabItem label="Code">

\`\`\`ts title="example.ts"
import { createApp } from '@lastshotlabs/slingshot';

const snippet = '~~~';
\`\`\`

  </TabItem>
</Tabs>
`);

    const blocks = extractTypescriptBlocks(filePath);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.code).toContain("const snippet = '~~~';");
  });
});

describe('buildWorkspacePathMappings', () => {
  test('maps the root package entry point', () => {
    const mappings = buildWorkspacePathMappings();
    expect(mappings['@lastshotlabs/slingshot']).toEqual(['src/index.ts']);
    expect(mappings['@lastshotlabs/slingshot/testing']).toEqual(['src/testing.ts']);
  });

  test('maps workspace package testing subpaths from export metadata', () => {
    const mappings = buildWorkspacePathMappings();
    expect(mappings['@lastshotlabs/slingshot-chat']).toEqual([
      'packages/slingshot-chat/src/index.ts',
    ]);
    expect(mappings['@lastshotlabs/slingshot-chat/testing']).toEqual([
      'packages/slingshot-chat/src/testing/index.ts',
    ]);
  });

  test('prefers explicit export targets for subpaths over guessed source files', () => {
    const mappings = buildWorkspacePathMappings();
    expect(mappings['@lastshotlabs/slingshot-core/content']).toEqual([
      'packages/slingshot-core/src/content.public.ts',
    ]);
  });
});
