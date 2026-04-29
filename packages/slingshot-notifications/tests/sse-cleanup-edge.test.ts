import { describe, expect, mock, test } from 'bun:test';

describe('SSE cleanup idempotency', () => {
  test('cleanup guard prevents double cleanup', () => {
    let cleanedUp = false;
    let callCount = 0;

    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      callCount++;
    };

    cleanup();
    cleanup();
    cleanup();
    expect(callCount).toBe(1);
  });

  test('cleanup handles undefined handlers gracefully', () => {
    let cleanedUp = false;
    let handler: (() => void) | undefined;

    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (handler) {
        handler();
        handler = undefined;
      }
    };

    // Should not throw even with undefined handler
    expect(() => cleanup()).not.toThrow();
  });

  test('cleanup safely calls handler that throws', () => {
    let cleanedUp = false;
    const handler = () => {
      throw new Error('cleanup handler error');
    };

    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      try {
        handler();
      } catch {
        // never throw from cleanup
      }
    };

    expect(() => cleanup()).not.toThrow();
    expect(cleanedUp).toBe(true);
  });

  test('cleanup resets handlers after calling', () => {
    let cleanedUp = false;
    let handler: (() => void) | undefined = mock(() => {});

    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (handler) {
        handler();
        handler = undefined;
      }
    };

    cleanup();
    expect(handler).toBeUndefined();
    expect(cleanedUp).toBe(true);
  });

  test('multiple cleanup calls do not invoke handler multiple times', () => {
    let cleanedUp = false;
    let callCount = 0;
    let handler: (() => void) | undefined = () => {
      callCount++;
    };

    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (handler) {
        handler();
        handler = undefined;
      }
    };

    cleanup();
    cleanup();
    cleanup();
    expect(callCount).toBe(1);
  });
});
