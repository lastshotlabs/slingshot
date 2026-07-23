import { expect, test } from 'bun:test';

test('loads the public error entrypoint', async () => {
  expect(await import('../src/errors')).toBeDefined();
});
