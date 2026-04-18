import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  deregisterApp,
  getAppsByResource,
  getAppsByStack,
  listApps,
  registerApp,
} from '../../../packages/slingshot-infra/src/registry/appRegistry';
import { createLocalRegistry } from '../../../packages/slingshot-infra/src/registry/localRegistry';
import type { RegistryProvider } from '../../../packages/slingshot-infra/src/types/registry';

describe('appRegistry', () => {
  let tempDir: string;
  let registry: RegistryProvider;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'slingshot-app-registry-test-'));
    registry = createLocalRegistry({ path: join(tempDir, 'registry.json') });
    await registry.initialize();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('registers an app and lists it', async () => {
    await registerApp(registry, {
      name: 'my-api',
      repo: 'https://github.com/org/my-api',
      stacks: ['main'],
      uses: ['postgres'],
    });

    const apps = await listApps(registry);
    expect(apps).toHaveLength(1);
    expect(apps[0].name).toBe('my-api');
    expect(apps[0].repo).toBe('https://github.com/org/my-api');
    expect(apps[0].stacks).toEqual(['main']);
    expect(apps[0].uses).toEqual(['postgres']);
    expect(apps[0].registeredAt).toBeTruthy();
  });

  it('updates an existing app without creating a duplicate', async () => {
    await registerApp(registry, {
      name: 'my-api',
      repo: 'https://github.com/org/my-api',
      stacks: ['main'],
      uses: ['postgres'],
    });

    await registerApp(registry, {
      name: 'my-api',
      repo: 'https://github.com/org/my-api',
      stacks: ['main', 'workers'],
      uses: ['postgres', 'redis'],
    });

    const apps = await listApps(registry);
    expect(apps).toHaveLength(1);
    expect(apps[0].stacks).toEqual(['main', 'workers']);
    expect(apps[0].uses).toEqual(['postgres', 'redis']);
  });

  it('filters apps by stack with getAppsByStack', async () => {
    await registerApp(registry, {
      name: 'api',
      repo: 'repo-a',
      stacks: ['main'],
      uses: [],
    });
    await registerApp(registry, {
      name: 'worker',
      repo: 'repo-b',
      stacks: ['workers'],
      uses: [],
    });
    await registerApp(registry, {
      name: 'dashboard',
      repo: 'repo-c',
      stacks: ['main', 'workers'],
      uses: [],
    });

    const mainApps = await getAppsByStack(registry, 'main');
    expect(mainApps).toHaveLength(2);
    expect(mainApps.map(a => a.name).sort()).toEqual(['api', 'dashboard']);

    const workerApps = await getAppsByStack(registry, 'workers');
    expect(workerApps).toHaveLength(2);
    expect(workerApps.map(a => a.name).sort()).toEqual(['dashboard', 'worker']);

    const noneApps = await getAppsByStack(registry, 'nonexistent');
    expect(noneApps).toHaveLength(0);
  });

  it('filters apps by resource with getAppsByResource', async () => {
    await registerApp(registry, {
      name: 'api',
      repo: 'repo-a',
      stacks: ['main'],
      uses: ['postgres', 'redis'],
    });
    await registerApp(registry, {
      name: 'worker',
      repo: 'repo-b',
      stacks: ['workers'],
      uses: ['redis'],
    });

    const pgApps = await getAppsByResource(registry, 'postgres');
    expect(pgApps).toHaveLength(1);
    expect(pgApps[0].name).toBe('api');

    const redisApps = await getAppsByResource(registry, 'redis');
    expect(redisApps).toHaveLength(2);
    expect(redisApps.map(a => a.name).sort()).toEqual(['api', 'worker']);

    const noneApps = await getAppsByResource(registry, 'kafka');
    expect(noneApps).toHaveLength(0);
  });

  it('deregisters an app', async () => {
    await registerApp(registry, {
      name: 'my-api',
      repo: 'repo',
      stacks: ['main'],
      uses: ['postgres'],
    });

    let apps = await listApps(registry);
    expect(apps).toHaveLength(1);

    await deregisterApp(registry, 'my-api');

    apps = await listApps(registry);
    expect(apps).toHaveLength(0);
  });

  it('returns empty arrays on empty registry', async () => {
    const apps = await listApps(registry);
    expect(apps).toEqual([]);

    const byStack = await getAppsByStack(registry, 'main');
    expect(byStack).toEqual([]);

    const byResource = await getAppsByResource(registry, 'postgres');
    expect(byResource).toEqual([]);
  });

  it('deregister is a no-op for non-existent app', async () => {
    // Should not throw
    await deregisterApp(registry, 'nonexistent');
    const apps = await listApps(registry);
    expect(apps).toEqual([]);
  });
});
