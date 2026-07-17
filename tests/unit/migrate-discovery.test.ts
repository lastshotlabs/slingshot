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
  const corePath = join(process.cwd(), 'packages/slingshot-core/src/index.ts');

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

  test('discovers entities declared through definePackage packages (#1)', async () => {
    const configPath = makeConfig(`
      import { defineApp } from '${defineAppPath}';
      import { definePackage } from '${corePath}';
      import { entity } from '${entityPath}';

      const Widget = {
        name: 'Widget',
        pluralName: 'Widgets',
        fields: {
          id: { type: 'string', primary: true },
          label: { type: 'string' },
        },
        relations: {},
        _pkField: 'id',
        _storageName: 'widgets',
      };

      const widgetsPackage = definePackage({
        name: 'widgets',
        entities: [entity({ config: Widget as any })],
      });

      export default defineApp({
        db: { sqlite: './app.db' },
        packages: [widgetsPackage],
      });
    `);

    const discovered = await loadManifest(configPath);

    expect(Object.keys(discovered.entities)).toEqual(['Widget']);
    expect(discovered.entities.Widget?._storageName).toBe('widgets');
    expect(pickBackend(discovered)).toBe('sqlite');
  });

  test('discovers plugin-tier AND package-tier entities together', async () => {
    const configPath = makeConfig(`
      import { defineApp } from '${defineAppPath}';
      import { createEntityPlugin } from '${entityPath}';
      import { definePackage } from '${corePath}';
      import { entity } from '${entityPath}';

      const Note = {
        name: 'Note', pluralName: 'Notes',
        fields: { id: { type: 'string', primary: true } },
        relations: {}, _pkField: 'id', _storageName: 'notes',
      };
      const Widget = {
        name: 'Widget', pluralName: 'Widgets',
        fields: { id: { type: 'string', primary: true } },
        relations: {}, _pkField: 'id', _storageName: 'widgets',
      };

      export default defineApp({
        db: { sqlite: './app.db' },
        plugins: [
          createEntityPlugin({
            name: 'notes',
            entities: [{ config: Note as any, buildAdapter: () => ({}) as any }],
          }),
        ],
        packages: [definePackage({ name: 'widgets', entities: [entity({ config: Widget as any })] })],
      });
    `);

    const discovered = await loadManifest(configPath);

    expect(Object.keys(discovered.entities).sort()).toEqual(['Note', 'Widget']);
  });
});
