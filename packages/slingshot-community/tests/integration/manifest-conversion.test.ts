import { afterEach, describe, expect, test } from 'bun:test';
import { communityManifest } from '../../src';
import { createHarness, get, post } from './_helpers';

describe('community manifest conversion', () => {
  let teardown: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await teardown?.();
    teardown = undefined;
  });

  test('boots from communityManifest with JSON-only config and mounts community routes', async () => {
    expect(communityManifest.manifestVersion).toBe(1);

    const harness = await createHarness({
      containerCreation: 'user',
      grantAll: true,
      usePluginStatePermissions: true,
    });
    teardown = harness.teardown;

    const createContainer = await post(harness.app, '/community/containers', {
      slug: 'general',
      name: 'General',
      createdBy: 'user-1',
    });
    expect(createContainer.status).toBe(201);
    const container = (await createContainer.json()) as { id: string };

    const listContainers = await get(harness.app, '/community/containers');
    expect(listContainers.status).toBe(200);

    const createThread = await post(harness.app, '/community/threads', {
      containerId: container.id,
      authorId: 'user-1',
      title: 'Manifest boot',
      body: 'Community routes are live',
    });
    expect(createThread.status).toBe(201);

    const sorted = await get(
      harness.app,
      `/community/threads/container/${container.id}/threads?sort=new`,
    );
    expect(sorted.status).not.toBe(404);
  });
});
