import { afterEach, describe, expect, test } from 'bun:test';
import { createTestApp, createTestPermissions } from '../../../tests/setup';
import { createEmojiPlugin } from '../src/plugin';

const createdApps: Array<{ destroy(): Promise<void> }> = [];

afterEach(async () => {
  for (const ctx of createdApps.splice(0)) {
    await ctx.destroy().catch(() => {});
  }
});

describe('slingshot-emoji smoke', () => {
  test('rejects invalid shortcode payloads before entity handling runs', async () => {
    const app = await createTestApp({
      plugins: [
        createEmojiPlugin({
          permissions: createTestPermissions(),
        }),
      ],
    });
    createdApps.push((app as { ctx: { destroy(): Promise<void> } }).ctx);

    const response = await app.request('/emoji', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        shortcode: 'Bad-Emoji',
        name: 'Bad Emoji',
        uploadKey: 'uploads/emoji.png',
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'Invalid shortcode',
    });
  });
});
