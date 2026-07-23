import { expect, test } from 'bun:test';

test('loads the package entrypoint', async () => {
  expect(await import('../src/index')).toBeDefined();
});
