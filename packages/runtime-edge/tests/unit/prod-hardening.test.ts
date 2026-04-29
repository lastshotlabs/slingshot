import { describe, expect, it } from 'bun:test';
import { configureRuntimeEdgeLogger, edgeRuntime } from '../../src/index';

describe('runtime-edge prod hardening', () => {
  describe('password hashing edge cases', () => {
    it('legacy hash with wrong format — single colon only', async () => {
      const runtime = edgeRuntime();
      expect(await runtime.password.verify('any', 'saltOnly')).toBe(false);
    });

    it('legacy hash with three parts rejected', async () => {
      const runtime = edgeRuntime();
      expect(await runtime.password.verify('any', 'a:b:c')).toBe(false);
    });

    it('modern hash with zero iteration count rejected', async () => {
      const runtime = edgeRuntime();
      expect(await runtime.password.verify('p', 'pbkdf2-sha256$0$abc$def')).toBe(false);
    });

    it('modern hash with negative iteration count rejected', async () => {
      const runtime = edgeRuntime();
      expect(await runtime.password.verify('p', 'pbkdf2-sha256$-1$abc$def')).toBe(false);
    });

    it('hash mismatch due to different length returns false', async () => {
      const runtime = edgeRuntime();
      const hash = await runtime.password.hash('short');
      // Corrupt the hash part — append extra base64 chars so the decoded
      // length will not match 32 bytes (SHA-256 output).
      const parts = hash.split('$');
      parts[3] = parts[3] + 'AA'; // Append 2 extra base64 chars
      const corrupted = parts.join('$');
      expect(await runtime.password.verify('short', corrupted)).toBe(false);
    });

    it('legacy hash with actual salt:hash mismatch returns false', async () => {
      // Precompute a legacy hash for 'real-pw' with a random salt.
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const enc = new TextEncoder().encode('real-pw');
      const key = await crypto.subtle.importKey('raw', enc, 'PBKDF2', false, ['deriveBits']);
      const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', iterations: 100_000, hash: 'SHA-256', salt },
        key,
        256,
      );
      const saltB64 = btoa(Array.from(salt, b => String.fromCharCode(b)).join(''));
      const hashB64 = btoa(Array.from(new Uint8Array(bits), b => String.fromCharCode(b)).join(''));

      const runtime = edgeRuntime();
      expect(await runtime.password.verify('real-pw', `${saltB64}:${hashB64}`)).toBe(true);
      // Wrong password with same salt+hash must fail (constant-time compare).
      expect(await runtime.password.verify('wrong-pw', `${saltB64}:${hashB64}`)).toBe(false);
    });
  });

  describe('logger', () => {
    it('configureRuntimeEdgeLogger returns previous logger', () => {
      const custom = {
        debug() {},
        info() {},
        warn() {},
        error() {},
        child() {
          return custom;
        },
      };
      const previous = configureRuntimeEdgeLogger(custom);
      expect(typeof previous).toBe('object');
      expect(typeof previous.debug).toBe('function');
      expect(typeof previous.warn).toBe('function');
      expect(typeof previous.error).toBe('function');
      const restored = configureRuntimeEdgeLogger(previous);
      expect(restored).toBe(custom);
    });
  });

  describe('readFile streaming edge cases', () => {
    it('handles empty stream chunks gracefully', async () => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(0)); // empty chunk
          controller.enqueue(new TextEncoder().encode('data'));
          controller.close();
        },
      });
      const runtime = edgeRuntime({
        maxFileBytes: 10,
        fileStore: async () => ({ stream }),
      });
      expect(await runtime.readFile('/empty-chunks')).toBe('data');
    });

    it('handles stream where done=true and value is undefined', async () => {
      let called = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!called) {
            called = true;
            controller.enqueue(new TextEncoder().encode('hi'));
          } else {
            controller.close();
          }
        },
      });
      const runtime = edgeRuntime({
        maxFileBytes: 10,
        fileStore: async () => ({ stream }),
      });
      expect(await runtime.readFile('/done-check')).toBe('hi');
    });
  });
});
