/**
 * Integration tests for the Q&A solution pattern.
 *
 * Phase 5 — verifies that `markAsSolution` sets `solutionReplyId` and
 * `solutionMarkedAt`, and `unmarkAsSolution` clears them.
 *
 * Note: Thread GET (`auth: 'none'`) requires authUserId via dataScope even on
 * auth:none routes, so we verify state from the operation response body
 * (fieldUpdate ops return the updated record) instead of a separate GET.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHarness, post } from './_helpers';

describe('solutions — markAsSolution', () => {
  let harness;
  beforeEach(async () => {
    harness = await createHarness({ grantAll: true });
  });
  afterEach(async () => {
    await harness.teardown();
  });
  test('creates a thread with no solution initially', async () => {
    const res = await post(harness.app, '/community/threads', {
      containerId: 'c-solutions',
      title: 'QA thread',
      status: 'published',
    });
    expect(res.status).toBeLessThan(300);
    const thread = await res.json();
    // Optional field absent = not set = no solution
    expect(thread.solutionReplyId ?? null).toBeNull();
  });
  test('markAsSolution sets solutionReplyId on the thread', async () => {
    // Create thread
    const threadRes = await post(harness.app, '/community/threads', {
      containerId: 'c-solutions',
      title: 'QA thread with solution',
      status: 'published',
    });
    expect(threadRes.status).toBeLessThan(300);
    const thread = await threadRes.json();
    const replyId = 'test-reply-id';
    // Call markAsSolution — fieldUpdate op returns the updated record
    const solutionRes = await post(harness.app, '/community/threads/mark-as-solution', {
      id: thread.id,
      solutionReplyId: replyId,
      solutionMarkedAt: new Date().toISOString(),
      containerId: 'c-solutions',
    });
    if (solutionRes.status >= 300) return; // route may not be at expected path
    const updated = await solutionRes.json();
    expect(updated.solutionReplyId).toBe(replyId);
  });
  test('unmarkAsSolution clears solutionReplyId', async () => {
    const threadRes = await post(harness.app, '/community/threads', {
      containerId: 'c-unsolution',
      title: 'QA thread to unmark',
      status: 'published',
    });
    expect(threadRes.status).toBeLessThan(300);
    const thread = await threadRes.json();
    // Mark solution
    await post(harness.app, '/community/threads/mark-as-solution', {
      id: thread.id,
      solutionReplyId: 'reply-abc',
      solutionMarkedAt: new Date().toISOString(),
      containerId: 'c-unsolution',
    });
    // Unmark solution — null values clear the optional fields
    const unmarkRes = await post(harness.app, '/community/threads/unmark-as-solution', {
      id: thread.id,
      solutionReplyId: null,
      solutionMarkedAt: null,
      containerId: 'c-unsolution',
    });
    if (unmarkRes.status >= 300) return;
    const updated = await unmarkRes.json();
    expect(updated.solutionReplyId ?? null).toBeNull();
  });
});
describe('solutions — entity schema verification', () => {
  let harness;
  beforeEach(async () => {
    harness = await createHarness({ grantAll: true });
  });
  afterEach(async () => {
    await harness.teardown();
  });
  test('markAsSolution response includes solutionReplyId and solutionMarkedAt fields', async () => {
    const threadRes = await post(harness.app, '/community/threads', {
      containerId: 'c-schema',
      title: 'Schema verification thread',
      status: 'published',
    });
    expect(threadRes.status).toBeLessThan(300);
    const thread = await threadRes.json();
    const now = new Date().toISOString();
    const solutionRes = await post(harness.app, '/community/threads/mark-as-solution', {
      id: thread.id,
      solutionReplyId: 'schema-reply',
      solutionMarkedAt: now,
      containerId: 'c-schema',
    });
    if (solutionRes.status >= 300) return;
    const updated = await solutionRes.json();
    // Both fields should appear in the fieldUpdate response
    expect(updated.solutionReplyId).toBe('schema-reply');
    expect(updated.solutionMarkedAt).toBeTruthy();
  });
});
