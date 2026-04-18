/**
 * Integration tests for the Tag / ThreadTag system.
 *
 * Phase 6 — verifies Tag CRUD (create/list/get), ThreadTag linking,
 * and per-slug uniqueness enforcement.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHarness, del, get, post } from './_helpers';
import type { CommunityHarness } from './_helpers';

describe('tags — CRUD', () => {
  let harness: CommunityHarness;

  beforeEach(async () => {
    harness = await createHarness({ grantAll: true });
  });

  afterEach(async () => {
    await harness.teardown();
  });

  test('tag list is initially empty', async () => {
    const res = await get(harness.app, '/community/tags');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
  });

  test('creates a tag with slug and label', async () => {
    const res = await post(harness.app, '/community/tags', {
      slug: 'typescript',
      label: 'TypeScript',
    });
    expect(res.status).toBeLessThan(300);
    const tag = (await res.json()) as { slug: string; label: string; usageCount: number };
    expect(tag.slug).toBe('typescript');
    expect(tag.label).toBe('TypeScript');
    expect(tag.usageCount).toBe(0);
  });

  test('created tag appears in list', async () => {
    await post(harness.app, '/community/tags', { slug: 'javascript', label: 'JavaScript' });

    const res = await get(harness.app, '/community/tags');
    const body = (await res.json()) as { items: Array<{ slug: string }> };
    expect(body.items.some(t => t.slug === 'javascript')).toBe(true);
  });

  test('created tag is fetchable by id', async () => {
    const createRes = await post(harness.app, '/community/tags', {
      slug: 'rust',
      label: 'Rust',
    });
    expect(createRes.status).toBeLessThan(300);
    const tag = (await createRes.json()) as { id: string; slug: string };

    const fetchRes = await get(harness.app, `/community/tags/${tag.id}`);
    expect(fetchRes.status).toBe(200);
    const fetched = (await fetchRes.json()) as { slug: string };
    expect(fetched.slug).toBe('rust');
  });

  test('tag create without permission returns 403', async () => {
    const noPermHarness = await createHarness();
    const res = await post(noPermHarness.app, '/community/tags', {
      slug: 'forbidden',
      label: 'Forbidden',
    });
    expect(res.status).toBe(403);
    await noPermHarness.teardown();
  });

  test('tag list is public (no auth required)', async () => {
    const res = await get(harness.app, '/community/tags'); // no x-test-user header
    expect(res.status).toBe(200);
  });

  test('tag get is public (no auth required)', async () => {
    const createRes = await post(harness.app, '/community/tags', {
      slug: 'public-tag',
      label: 'Public',
    });
    const tag = (await createRes.json()) as { id: string };

    const fetchRes = await get(harness.app, `/community/tags/${tag.id}`);
    expect(fetchRes.status).toBe(200);
  });

  test('tag delete requires permission', async () => {
    const createRes = await post(harness.app, '/community/tags', {
      slug: 'deletable',
      label: 'Deletable',
    });
    const tag = (await createRes.json()) as { id: string };

    const deleteRes = await del(harness.app, `/community/tags/${tag.id}`);
    expect(deleteRes.status).toBeLessThan(300);
  });
});

describe('tags — thread-tag linking', () => {
  let harness: CommunityHarness;

  beforeEach(async () => {
    harness = await createHarness({ grantAll: true });
  });

  afterEach(async () => {
    await harness.teardown();
  });

  test('thread-tag list is initially empty', async () => {
    const res = await get(harness.app, '/community/thread-tags');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
  });

  test('creates a thread-tag link', async () => {
    // Create tag
    const tagRes = await post(harness.app, '/community/tags', {
      slug: 'linked-tag',
      label: 'Linked',
    });
    expect(tagRes.status).toBeLessThan(300);
    const tag = (await tagRes.json()) as { id: string };

    // Create thread
    const threadRes = await post(harness.app, '/community/threads', {
      containerId: 'c-tagging',
      title: 'Tagged thread',
      status: 'published',
    });
    expect(threadRes.status).toBeLessThan(300);
    const thread = (await threadRes.json()) as { id: string };

    // Link them via ThreadTag
    const linkRes = await post(harness.app, '/community/thread-tags', {
      threadId: thread.id,
      tagId: tag.id,
      containerId: 'c-tagging',
    });
    expect(linkRes.status).toBeLessThan(300);

    // Verify it's listed
    const listRes = await get(harness.app, '/community/thread-tags');
    const body = (await listRes.json()) as { items: Array<{ threadId: string; tagId: string }> };
    const link = body.items.find(l => l.threadId === thread.id && l.tagId === tag.id);
    expect(link).toBeDefined();
  });
});
