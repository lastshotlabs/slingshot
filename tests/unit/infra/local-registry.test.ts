import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createLocalRegistry } from '../../../packages/slingshot-infra/src/registry/localRegistry';
import { createEmptyRegistryDocument } from '../../../packages/slingshot-infra/src/types/registry';

describe('createLocalRegistry', () => {
  let tempDir: string;
  let registryPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'slingshot-test-'));
    registryPath = join(tempDir, 'registry.json');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('initializes a new registry file', async () => {
    const registry = createLocalRegistry({ path: registryPath });
    await registry.initialize();

    expect(existsSync(registryPath)).toBe(true);
    const doc = await registry.read();
    expect(doc).not.toBeNull();
    expect(doc!.version).toBe(1);
    expect(doc!.stacks).toEqual({});
    expect(doc!.resources).toEqual({});
    expect(doc!.services).toEqual({});
  });

  it('reads and writes documents', async () => {
    const registry = createLocalRegistry({ path: registryPath });
    await registry.initialize();

    const doc = createEmptyRegistryDocument('testorg');
    doc.stacks['main'] = {
      preset: 'ecs',
      stages: {
        prod: {
          status: 'active',
          outputs: { vpcId: 'vpc-123' },
          updatedAt: new Date().toISOString(),
        },
      },
    };

    await registry.write(doc);
    const readBack = await registry.read();

    expect(readBack!.platform).toBe('testorg');
    expect(readBack!.stacks.main.preset).toBe('ecs');
    expect(readBack!.stacks.main.stages.prod.outputs.vpcId).toBe('vpc-123');
  });

  it('returns null for non-existent file', async () => {
    const registry = createLocalRegistry({ path: registryPath });
    const doc = await registry.read();
    expect(doc).toBeNull();
  });

  it('supports optimistic locking', async () => {
    const registry = createLocalRegistry({ path: registryPath });
    await registry.initialize();

    const doc = await registry.read();
    const lock = await registry.lock();

    doc!.platform = 'updated';
    await registry.write(doc!, lock.etag);
    await lock.release();

    const readBack = await registry.read();
    expect(readBack!.platform).toBe('updated');
  });

  it('detects concurrent modifications', async () => {
    const registry = createLocalRegistry({ path: registryPath });
    await registry.initialize();

    // Read to get etag
    await registry.read();
    const lock = await registry.lock();
    const staleEtag = lock.etag;

    // Write with a different registry instance (simulating concurrent writer)
    const registry2 = createLocalRegistry({ path: registryPath });
    const doc = await registry2.read();
    doc!.platform = 'writer2';
    await registry2.write(doc!);

    // Now try to write with stale etag
    const doc2 = createEmptyRegistryDocument('writer1');
    await expect(registry.write(doc2, staleEtag)).rejects.toThrow('modified by another process');
  });

  it('creates parent directories if needed', async () => {
    const nestedPath = join(tempDir, 'nested', 'deep', 'registry.json');
    const registry = createLocalRegistry({ path: nestedPath });
    await registry.initialize();

    expect(existsSync(nestedPath)).toBe(true);
  });

  it('does not overwrite existing registry on initialize', async () => {
    const registry = createLocalRegistry({ path: registryPath });
    await registry.initialize();

    const doc = await registry.read();
    doc!.platform = 'should-persist';
    await registry.write(doc!);

    // Initialize again — should not overwrite
    await registry.initialize();
    const readBack = await registry.read();
    expect(readBack!.platform).toBe('should-persist');
  });
});
