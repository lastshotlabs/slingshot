/**
 * `@anthropic-ai/sdk` is an OPTIONAL peer of `slingshot-ai`, so an app that only
 * talks to a local model never has to install it. The cost of that choice is
 * that "configured `anthropic` but never installed the SDK" is a real state a
 * user can reach — and it must produce an error that says what to run, at BOOT,
 * rather than a module-resolution stack trace at the moment someone taps a
 * button.
 *
 * Isolated because `mock.module` is process-wide.
 */
import { beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('@anthropic-ai/sdk', () => {
  throw new Error("Cannot find package '@anthropic-ai/sdk'");
});

let createAnthropicProvider: typeof import('../../packages/slingshot-ai/src/provider/anthropic').createAnthropicProvider;

beforeAll(async () => {
  ({ createAnthropicProvider } =
    await import('../../packages/slingshot-ai/src/provider/anthropic'));
});

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe('anthropic provider without @anthropic-ai/sdk installed', () => {
  it('names the install command instead of leaking a resolution error', async () => {
    await expect(
      createAnthropicProvider(
        'anthropic',
        { apiKey: 'sk-test' },
        { apiKey: 'sk-test', logger: silentLogger },
      ),
    ).rejects.toThrow(
      "The 'anthropic' provider requires @anthropic-ai/sdk to be installed. Run: bun add @anthropic-ai/sdk",
    );
  });

  it('fails on the missing key before it ever reaches the SDK', async () => {
    // Ordering matters: a missing key is a config error we can report precisely,
    // and reporting it takes priority over "your optional peer is missing".
    await expect(
      createAnthropicProvider('anthropic', {}, { apiKey: null, logger: silentLogger }),
    ).rejects.toThrow(/has no API key/);
  });
});
