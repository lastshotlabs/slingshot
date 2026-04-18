import { checkBreachedPassword } from '@auth/lib/breachedPassword';
import { describe, expect, spyOn, test } from 'bun:test';

const noopEventBus = {
  emit: () => {},
  on: () => {},
  off: () => {},
} as any;

describe('checkBreachedPassword', () => {
  test('returns not breached when suffix not in response', async () => {
    // Mock fetch to return a response that doesn't include our hash suffix
    const mockFetch = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        '00000000000000000000000000000000000:5\r\nFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:3',
        {
          status: 200,
        },
      ),
    );

    const result = await checkBreachedPassword(
      'verysecurepassword123!',
      undefined,
      undefined,
      noopEventBus,
    );
    expect(result.breached).toBe(false);
    expect(result.count).toBe(0);
    mockFetch.mockRestore();
  });

  test('returns breached: false on API failure with onApiFailure=allow', async () => {
    const mockFetch = spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'));

    const result = await checkBreachedPassword(
      'password',
      { onApiFailure: 'allow' },
      undefined,
      noopEventBus,
    );
    expect(result.breached).toBe(false);
    mockFetch.mockRestore();
  });

  test('returns breached: true on API failure with onApiFailure=block', async () => {
    const mockFetch = spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'));

    const result = await checkBreachedPassword(
      'password',
      { onApiFailure: 'block' },
      undefined,
      noopEventBus,
    );
    expect(result.breached).toBe(true);
    mockFetch.mockRestore();
  });

  test('respects minBreachCount', async () => {
    // Mock returns empty body — suffix won't be found, count=0 < minBreachCount=10
    const mockFetch = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('', { status: 200 }),
    );

    const result = await checkBreachedPassword(
      'somepassword',
      { minBreachCount: 10 },
      undefined,
      noopEventBus,
    );
    expect(result.breached).toBe(false); // count=0 < minBreachCount=10
    mockFetch.mockRestore();
  });
});
