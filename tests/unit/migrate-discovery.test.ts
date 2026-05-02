import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { loadManifest, pickBackend } from '../../src/cli/lib/migrate/discover';

describe('migrate app.config discovery', () => {
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeConfig(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'slingshot-migrate-discovery-'));
    created.push(dir);
    const configPath = join(dir, 'app.config.ts');
    writeFileSync(configPath, contents, 'utf8');
    return configPath;
  }

  const defineAppPath = join(process.cwd(), 'src/defineApp.ts');
  const entityPath = join(process.cwd(), 'packages/slingshot-entity/src/index.ts');

  test('loads code-first entity plugins from app.config.ts', async () => {
    const configPath = makeConfig(`
      import { defineApp } from '${defineAppPath}';
      import { createEntityPlugin } from '${entityPath}';

      const Note = {
        name: 'Note',
        pluralName: 'Notes',
        fields: {
          id: { type: 'string', primary: true },
          title: { type: 'string' },
        },
        relations: {},
        _pkField: 'id',
        _storageName: 'notes',
      };

      export default defineApp({
        db: { sqlite: './app.db' },
        plugins: [
          createEntityPlugin({
            name: 'notes',
            entities: [{ config: Note as any, buildAdapter: () => ({}) as any }],
          }),
        ],
      });
    `);

    const discovered = await loadManifest(configPath);

    expect(Object.keys(discovered.entities)).toEqual(['Note']);
    expect(discovered.entities.Note?._storageName).toBe('notes');
    expect(pickBackend(discovered)).toBe('sqlite');
  });

  test('loads manifest-backed entity plugins from app.config.ts', async () => {
    const configPath = makeConfig(`
      import { defineApp } from '${defineAppPath}';
      import { createEntityPlugin } from '${entityPath}';

      export default defineApp({
        db: { sqlite: './app.db' },
        plugins: [
          createEntityPlugin({
            name: 'content',
            manifest: {
              manifestVersion: 1,
              entities: {
                Article: {
                  fields: {
                    id: { type: 'string', primary: true },
                    title: { type: 'string' },
                  },
                },
              },
            },
          }),
        ],
      });
    `);

    const discovered = await loadManifest(configPath);

    expect(Object.keys(discovered.entities)).toEqual(['Article']);
    expect(discovered.entities.Article?._storageName).toBe('articles');
    expect(pickBackend(discovered)).toBe('sqlite');
  });
});
