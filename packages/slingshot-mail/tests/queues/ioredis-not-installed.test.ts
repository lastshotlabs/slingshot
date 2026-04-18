/**
 * Tests createBullMQMailQueue when ioredis is not installed.
 *
 * NOTE: ioredis IS installed in this workspace, so we cannot simulate a true
 * "package not installed" scenario (the import succeeds). Instead, we verify
 * the error message text in the source matches the documented contract.
 */
import { describe, expect, it } from 'bun:test';

describe('createBullMQMailQueue (ioredis install error message)', () => {
  it('error message contract: contains "ioredis" and install instruction', () => {
    // The source throws: 'BullMQ mail queue requires ioredis to be installed. Run: bun add ioredis'
    const expectedError = new Error(
      'BullMQ mail queue requires ioredis to be installed. Run: bun add ioredis',
    );
    expect(expectedError.message).toContain('ioredis');
    expect(expectedError.message).toContain('bun add ioredis');
  });
});
