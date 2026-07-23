import { expect, test } from 'bun:test';

test('loads the public capability entrypoint', async () => {
  expect(await import('../src/public')).toBeDefined();
});
