import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createSecretsManager } from '../../../packages/slingshot-infra/src/secrets/secretsManager';

describe('createSecretsManager - env provider', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore original env
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  it('check() finds keys present in process.env', async () => {
    process.env.MY_SECRET = 'secret-value';
    process.env.MY_TOKEN = 'token-value';

    const sm = createSecretsManager({ provider: 'env' }, 'prod');
    const result = await sm.check(['MY_SECRET', 'MY_TOKEN', 'MISSING_KEY']);

    expect(result.found).toEqual(['MY_SECRET', 'MY_TOKEN']);
    expect(result.missing).toEqual(['MISSING_KEY']);
  });

  it('check() reports all keys missing when none are set', async () => {
    delete process.env.FOO;
    delete process.env.BAR;

    const sm = createSecretsManager({ provider: 'env' }, 'prod');
    const result = await sm.check(['FOO', 'BAR']);

    expect(result.found).toEqual([]);
    expect(result.missing).toEqual(['FOO', 'BAR']);
  });

  it('check() reports all keys found when all are set', async () => {
    process.env.A_KEY = 'a';
    process.env.B_KEY = 'b';

    const sm = createSecretsManager({ provider: 'env' }, 'prod');
    const result = await sm.check(['A_KEY', 'B_KEY']);

    expect(result.found).toEqual(['A_KEY', 'B_KEY']);
    expect(result.missing).toEqual([]);
  });
});

describe('createSecretsManager - file provider', () => {
  let tempDir: string;
  let secretsDir: string;
  let appRoot: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'slingshot-secrets-test-'));
    secretsDir = join(tempDir, 'secrets');
    appRoot = join(tempDir, 'app');
    // Create app root directory
    const { mkdirSync } = require('node:fs');
    mkdirSync(appRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('push writes key files to the secrets directory', async () => {
    // Create .env file in appRoot
    writeFileSync(join(appRoot, '.env'), 'DB_URL=postgres://localhost\nAPI_KEY=abc123\n');

    const sm = createSecretsManager({ provider: 'file', directory: secretsDir }, 'prod');
    const result = await sm.push(appRoot, ['DB_URL', 'API_KEY']);

    expect(result.pushed).toEqual(['DB_URL', 'API_KEY']);
    expect(readFileSync(join(secretsDir, 'DB_URL'), 'utf-8')).toBe('postgres://localhost');
    expect(readFileSync(join(secretsDir, 'API_KEY'), 'utf-8')).toBe('abc123');
  });

  it('push reads from stage-specific .env file when it exists', async () => {
    writeFileSync(join(appRoot, '.env.staging'), 'SECRET=staging-val\n');

    const sm = createSecretsManager({ provider: 'file', directory: secretsDir }, 'staging');
    const result = await sm.push(appRoot, ['SECRET']);

    expect(result.pushed).toEqual(['SECRET']);
    expect(readFileSync(join(secretsDir, 'SECRET'), 'utf-8')).toBe('staging-val');
  });

  it('push throws when .env file is missing', async () => {
    const sm = createSecretsManager({ provider: 'file', directory: secretsDir }, 'prod');

    await expect(sm.push(join(tempDir, 'nonexistent'), ['KEY'])).rejects.toThrow(
      'No .env file found',
    );
  });

  it('push skips keys not in .env file', async () => {
    writeFileSync(join(appRoot, '.env'), 'PRESENT=value\n');

    const sm = createSecretsManager({ provider: 'file', directory: secretsDir }, 'prod');
    const result = await sm.push(appRoot, ['PRESENT', 'ABSENT']);

    expect(result.pushed).toEqual(['PRESENT']);
    expect(existsSync(join(secretsDir, 'ABSENT'))).toBe(false);
  });

  it('pull reads key files into .env', async () => {
    const { mkdirSync } = require('node:fs');
    mkdirSync(secretsDir, { recursive: true });
    writeFileSync(join(secretsDir, 'DB_URL'), 'postgres://prod-db');
    writeFileSync(join(secretsDir, 'REDIS_URL'), 'redis://prod-redis');

    const sm = createSecretsManager({ provider: 'file', directory: secretsDir }, 'prod');
    const result = await sm.pull(appRoot, ['DB_URL', 'REDIS_URL']);

    expect(result.pulled).toEqual(['DB_URL', 'REDIS_URL']);

    const envContent = readFileSync(join(appRoot, '.env'), 'utf-8');
    expect(envContent).toContain('DB_URL=postgres://prod-db');
    expect(envContent).toContain('REDIS_URL=redis://prod-redis');
  });

  it('pull skips missing key files', async () => {
    const { mkdirSync } = require('node:fs');
    mkdirSync(secretsDir, { recursive: true });
    writeFileSync(join(secretsDir, 'EXISTS'), 'val');

    const sm = createSecretsManager({ provider: 'file', directory: secretsDir }, 'prod');
    const result = await sm.pull(appRoot, ['EXISTS', 'NOPE']);

    expect(result.pulled).toEqual(['EXISTS']);
  });

  it('check finds existing key files and reports missing', async () => {
    const { mkdirSync } = require('node:fs');
    mkdirSync(secretsDir, { recursive: true });
    writeFileSync(join(secretsDir, 'FOUND_KEY'), 'val');

    const sm = createSecretsManager({ provider: 'file', directory: secretsDir }, 'prod');
    const result = await sm.check(['FOUND_KEY', 'MISSING_KEY']);

    expect(result.found).toEqual(['FOUND_KEY']);
    expect(result.missing).toEqual(['MISSING_KEY']);
  });

  it('push handles quoted values in .env file', async () => {
    writeFileSync(join(appRoot, '.env'), 'QUOTED="hello world"\nSINGLE=\'single val\'\n');

    const sm = createSecretsManager({ provider: 'file', directory: secretsDir }, 'prod');
    const result = await sm.push(appRoot, ['QUOTED', 'SINGLE']);

    expect(result.pushed).toEqual(['QUOTED', 'SINGLE']);
    expect(readFileSync(join(secretsDir, 'QUOTED'), 'utf-8')).toBe('hello world');
    expect(readFileSync(join(secretsDir, 'SINGLE'), 'utf-8')).toBe('single val');
  });

  it('push ignores comments and blank lines in .env file', async () => {
    writeFileSync(
      join(appRoot, '.env'),
      '# This is a comment\n\nKEY=value\n  \n# Another comment\n',
    );

    const sm = createSecretsManager({ provider: 'file', directory: secretsDir }, 'prod');
    const result = await sm.push(appRoot, ['KEY']);

    expect(result.pushed).toEqual(['KEY']);
    expect(readFileSync(join(secretsDir, 'KEY'), 'utf-8')).toBe('value');
  });
});
