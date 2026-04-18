import { rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import { resolveRepoIdentity } from '../../../packages/slingshot-infra/src/config/resolveRepoIdentity';
import { createRegistryFromConfig } from '../../../packages/slingshot-infra/src/registry/createRegistryFromConfig';
import { parseRegistryUrl } from '../../../packages/slingshot-infra/src/registry/parseRegistryUrl';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('registry utilities', () => {
  it('parses registry URLs into provider configs', () => {
    expect(parseRegistryUrl('s3://slingshot-registry')).toEqual({
      provider: 's3',
      bucket: 'slingshot-registry',
    });
    expect(parseRegistryUrl('redis://localhost:6379')).toEqual({
      provider: 'redis',
      url: 'redis://localhost:6379',
    });
    expect(parseRegistryUrl('postgres://user:pass@localhost/db')).toEqual({
      provider: 'postgres',
      connectionString: 'postgres://user:pass@localhost/db',
    });
    expect(parseRegistryUrl('/tmp/slingshot-registry.json')).toEqual({
      provider: 'local',
      path: '/tmp/slingshot-registry.json',
    });
  });

  it('creates the correct registry provider dispatch by config type', () => {
    expect(
      createRegistryFromConfig({ provider: 'redis', url: 'redis://localhost:6379' }).name,
    ).toBe('redis');
    expect(
      createRegistryFromConfig({
        provider: 'postgres',
        connectionString: 'postgres://user:pass@localhost/db',
      }).name,
    ).toBe('postgres');
  });

  it('resolves repo identity from package.json name and strips scope', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slingshot-repo-id-'));
    tempDirs.push(dir);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@scope/my-app' }), 'utf-8');

    expect(resolveRepoIdentity(dir)).toBe('my-app');
  });

  it('throws when repo identity cannot be resolved', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slingshot-repo-id-missing-'));
    tempDirs.push(dir);

    expect(() => resolveRepoIdentity(dir)).toThrow('Cannot determine repo identity');
  });
});
