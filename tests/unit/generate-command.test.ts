/**
 * CLI dry-run exercise for `slingshot generate --migration`.
 *
 * Writes a real entity definition file to a temp directory, invokes the Generate oclif
 * command against it with --dry-run and --migration, and asserts that the snapshot
 * lifecycle + migration output behaves correctly end-to-end through the CLI wrapper.
 */
import { afterAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import Generate from '../../src/cli/commands/generate';

const TMP_ROOT = join(import.meta.dir, '.tmp-generate-command-test');
const OUT_DIR = join(TMP_ROOT, 'generated');
const SNAPSHOT_DIR = join(TMP_ROOT, 'snapshots');
const DEFINITION_V1 = join(TMP_ROOT, 'order-v1.ts');
const DEFINITION_V2 = join(TMP_ROOT, 'order-v2.ts');

// Minimal oclif config stub — Command.parse() only touches a handful of methods.
function makeOclifConfig() {
  return {
    runHook: async () => ({ successes: [], failures: [] }),
    scopedEnvVar: () => undefined,
    scopedEnvVarKey: (key: string) => key,
    scopedEnvVarKeys: () => [],
    bin: 'slingshot',
    userAgent: 'slingshot/test',
    theme: undefined,
    findCommand: () => undefined,
  };
}

function makeCommand(argv: string[]) {
  return new Generate(argv, makeOclifConfig() as never);
}

const SLINGSHOT_ENTITY_PATH = require.resolve('@lastshotlabs/slingshot-entity').replace(/\\/g, '/');

const ENTITY_SOURCE_V1 = `
import { defineEntity, field, index } from '${SLINGSHOT_ENTITY_PATH}';

export const OrderEntity = defineEntity('Order', {
  namespace: 'shop',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    customerId: field.string(),
    total: field.number({ default: 0 }),
    createdAt: field.date({ default: 'now' }),
  },
  indexes: [index(['customerId'])],
});
`;

const ENTITY_SOURCE_V2 = `
import { defineEntity, field, index } from '${SLINGSHOT_ENTITY_PATH}';

export const OrderEntity = defineEntity('Order', {
  namespace: 'shop',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    customerId: field.string(),
    total: field.number({ default: 0 }),
    trackingCode: field.string({ optional: true }),
    createdAt: field.date({ default: 'now' }),
  },
  indexes: [index(['customerId']), index(['trackingCode'])],
});
`;

beforeEach(() => {
  if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
  mkdirSync(TMP_ROOT, { recursive: true });
  writeFileSync(DEFINITION_V1, ENTITY_SOURCE_V1, 'utf-8');
  writeFileSync(DEFINITION_V2, ENTITY_SOURCE_V2, 'utf-8');
});

afterAll(() => {
  if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe('slingshot generate CLI', () => {
  it('dry-run lists generated source files for a first run with no snapshot', async () => {
    const cmd = makeCommand([
      '--definition',
      DEFINITION_V1,
      '--outdir',
      OUT_DIR,
      '--snapshot-dir',
      SNAPSHOT_DIR,
      '--dry-run',
    ]);

    const logs: string[] = [];
    spyOn(cmd, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    await cmd.run();

    const output = logs.join('\n');
    expect(output).toContain('Generated files (dry run):');
    expect(output).toContain('types.ts');
    expect(output).toContain('schemas.ts');
    expect(output).toContain('adapter.ts');
    expect(output).toContain('sqlite.ts');
    expect(output).toContain('postgres.ts');
    // First run has no snapshot → no migration files should appear.
    expect(output).not.toContain('migrations/');
    // Dry run must not write files.
    expect(existsSync(OUT_DIR)).toBe(false);
  });

  it('dry-run with --migration emits per-backend migration files after a snapshot exists', async () => {
    // First, persist a V1 snapshot (non dry-run so the snapshot is written).
    const seedCmd = makeCommand([
      '--definition',
      DEFINITION_V1,
      '--outdir',
      OUT_DIR,
      '--snapshot-dir',
      SNAPSHOT_DIR,
    ]);
    spyOn(seedCmd, 'log').mockImplementation(() => {});
    await seedCmd.run();
    expect(existsSync(SNAPSHOT_DIR)).toBe(true);

    // Now run V2 with --migration --dry-run and inspect the log output.
    const cmd = makeCommand([
      '--definition',
      DEFINITION_V2,
      '--outdir',
      OUT_DIR,
      '--snapshot-dir',
      SNAPSHOT_DIR,
      '--migration',
      '--dry-run',
    ]);

    const logs: string[] = [];
    spyOn(cmd, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    await cmd.run();

    const output = logs.join('\n');
    expect(output).toContain('migrations/sqlite.sql');
    expect(output).toContain('migrations/postgres.sql');
    expect(output).toContain('migrations/mongo.js');
  });

  it('dry-run with --manifest generates files for each entity', async () => {
    const manifestPath = join(TMP_ROOT, 'entities.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        manifestVersion: 1,
        namespace: 'shop',
        entities: {
          Product: {
            fields: {
              id: { type: 'string', primary: true, default: 'uuid' },
              name: { type: 'string' },
              price: { type: 'number', default: 0 },
            },
          },
        },
      }),
      'utf-8',
    );

    const cmd = makeCommand([
      '--manifest',
      manifestPath,
      '--outdir',
      OUT_DIR,
      '--snapshot-dir',
      SNAPSHOT_DIR,
      '--dry-run',
    ]);

    const logs: string[] = [];
    spyOn(cmd, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    await cmd.run();

    const output = logs.join('\n');
    expect(output).toContain('Generated files (dry run):');
    expect(output).toContain('types.ts');
  });

  it('errors on invalid manifest JSON', async () => {
    const manifestPath = join(TMP_ROOT, 'bad.json');
    writeFileSync(manifestPath, '{ not valid json }', 'utf-8');

    const cmd = makeCommand(['--manifest', manifestPath, '--outdir', OUT_DIR]);

    spyOn(cmd, 'log').mockImplementation(() => {});
    spyOn(cmd, 'error').mockImplementation((msg: string) => {
      throw new Error(msg);
    });

    await expect(cmd.run()).rejects.toThrow(/Failed to read manifest/);
  });

  it('errors on invalid manifest schema', async () => {
    const manifestPath = join(TMP_ROOT, 'bad-schema.json');
    writeFileSync(manifestPath, JSON.stringify({ wrong: 'data' }), 'utf-8');

    const cmd = makeCommand(['--manifest', manifestPath, '--outdir', OUT_DIR]);

    spyOn(cmd, 'log').mockImplementation(() => {});
    spyOn(cmd, 'error').mockImplementation((msg: string) => {
      throw new Error(msg);
    });

    await expect(cmd.run()).rejects.toThrow(/Invalid manifest/);
  });

  it('dry-run with --migration and no prior snapshot emits no migration files', async () => {
    const cmd = makeCommand([
      '--definition',
      DEFINITION_V1,
      '--outdir',
      OUT_DIR,
      '--snapshot-dir',
      SNAPSHOT_DIR,
      '--migration',
      '--dry-run',
    ]);

    const logs: string[] = [];
    spyOn(cmd, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    await cmd.run();

    const output = logs.join('\n');
    expect(output).toContain('Generated files (dry run):');
    expect(output).not.toContain('migrations/');
  });
});
