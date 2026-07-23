import { expect, test } from 'bun:test';

test('loads the loader entrypoint', async () => {
  expect(await import('../src/loaders')).toBeDefined();
});
