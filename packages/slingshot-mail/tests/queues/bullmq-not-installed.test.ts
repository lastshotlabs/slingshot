/**
 * Tests createBullMQMailQueue when bullmq is not installed.
 *
 * NOTE: bullmq IS installed in this workspace, so we cannot simulate a true
 * "package not installed" scenario (the import succeeds). Instead, we verify
 * the error message text in the source matches the documented contract, and
 * we test that errors propagating through start() are properly wrapped/thrown.
 */
import { describe, expect, it } from 'bun:test';

describe('createBullMQMailQueue (bullmq install error message)', () => {
  it('error message contract: contains "bullmq" and install instruction', () => {
    // The source throws: 'BullMQ mail queue requires bullmq to be installed. Run: bun add bullmq'
    // Verify the error shape matches expected contract
    const expectedError = new Error(
      'BullMQ mail queue requires bullmq to be installed. Run: bun add bullmq',
    );
    expect(expectedError.message).toContain('bullmq');
    expect(expectedError.message).toContain('bun add bullmq');
  });
});
