import type { RegistryAppEntry, RegistryProvider } from '../types/registry';
import { createEmptyRegistryDocument } from '../types/registry';

/**
 * Register (or update) an app entry in the registry for cross-repo coordination.
 *
 * Uses an optimistic lock to prevent concurrent writes from clobbering each
 * other. After a successful write the app appears in `listApps()` and can be
 * discovered by `getAppsByStack()` and `getAppsByResource()`.
 *
 * @param registry - The registry provider to write to.
 * @param app - App metadata to store.
 * @param app.name - Logical app name (unique within the registry).
 * @param app.repo - Repository URL or identifier.
 * @param app.stacks - Stack names this app deploys to.
 * @param app.uses - Shared resource names this app consumes.
 *
 * @example
 * ```ts
 * import { registerApp } from '@lastshotlabs/slingshot-infra';
 *
 * await registerApp(registry, {
 *   name: 'api',
 *   repo: 'github.com/acme/api',
 *   stacks: ['main'],
 *   uses: ['postgres', 'redis'],
 * });
 * ```
 */
export async function registerApp(
  registry: RegistryProvider,
  app: { name: string; repo: string; stacks: string[]; uses: string[] },
): Promise<void> {
  const lock = await registry.lock();
  try {
    let doc = await registry.read();
    if (!doc) {
      doc = createEmptyRegistryDocument('');
    }
    if (!doc.apps) {
      doc.apps = {};
    }
    doc.apps[app.name] = {
      name: app.name,
      repo: app.repo,
      stacks: app.stacks,
      uses: app.uses,
      registeredAt: new Date().toISOString(),
    };
    await registry.write(doc, lock.etag);
  } finally {
    await lock.release();
  }
}

/**
 * List all registered apps in the registry.
 *
 * @param registry - The registry provider to read from.
 * @returns All `RegistryAppEntry` records, or an empty array if none are registered.
 */
export async function listApps(registry: RegistryProvider): Promise<RegistryAppEntry[]> {
  const doc = await registry.read();
  if (!doc?.apps) return [];
  return Object.values(doc.apps);
}

/**
 * Return all registered apps that deploy to the given stack.
 *
 * @param registry - The registry provider to read from.
 * @param stackName - Stack name to filter by.
 * @returns Apps whose `stacks` array contains `stackName`.
 */
export async function getAppsByStack(
  registry: RegistryProvider,
  stackName: string,
): Promise<RegistryAppEntry[]> {
  const doc = await registry.read();
  if (!doc?.apps) return [];
  return Object.values(doc.apps).filter(app => app.stacks.includes(stackName));
}

/**
 * Return all registered apps that consume the given shared resource.
 *
 * @param registry - The registry provider to read from.
 * @param resourceName - Resource name to filter by (e.g. `'postgres'`).
 * @returns Apps whose `uses` array contains `resourceName`.
 */
export async function getAppsByResource(
  registry: RegistryProvider,
  resourceName: string,
): Promise<RegistryAppEntry[]> {
  const doc = await registry.read();
  if (!doc?.apps) return [];
  return Object.values(doc.apps).filter(app => app.uses.includes(resourceName));
}

/**
 * Remove a registered app from the registry.
 *
 * Uses an optimistic lock to prevent concurrent writes from clobbering each
 * other. If the app is not found, the function returns silently without error.
 *
 * @param registry - The registry provider to write to.
 * @param appName - Logical app name to remove (must match a key in `doc.apps`).
 *
 * @example
 * ```ts
 * import { deregisterApp } from '@lastshotlabs/slingshot-infra';
 *
 * await deregisterApp(registry, 'api');
 * ```
 */
export async function deregisterApp(registry: RegistryProvider, appName: string): Promise<void> {
  const lock = await registry.lock();
  try {
    const doc = await registry.read();
    if (!doc?.apps) return;
    doc.apps = Object.fromEntries(Object.entries(doc.apps).filter(([name]) => name !== appName));
    await registry.write(doc, lock.etag);
  } finally {
    await lock.release();
  }
}
