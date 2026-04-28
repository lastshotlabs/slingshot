// Unit tests for the tri-state exit-code resolver (P-SSG-2).
//
// Replaces the previous binary 0/1 model so CI can distinguish a run where
// some routes succeeded and others failed (degraded but published) from a
// run where everything failed (no output at all).
import { describe, expect, test } from 'bun:test';
import { resolveExitCode } from '../src/cli';

describe('resolveExitCode (P-SSG-2)', () => {
  test('returns 0 when no failures', () => {
    expect(resolveExitCode(10, 0)).toBe(0);
  });

  test('returns 0 when nothing was rendered (vacuous success)', () => {
    expect(resolveExitCode(0, 0)).toBe(0);
  });

  test('returns 2 when at least one page succeeded and at least one failed', () => {
    expect(resolveExitCode(9, 1)).toBe(2);
    expect(resolveExitCode(1, 9)).toBe(2);
  });

  test('returns 1 when every page failed (total failure)', () => {
    expect(resolveExitCode(0, 5)).toBe(1);
  });

  test('returns 1 when one page failed and zero succeeded', () => {
    expect(resolveExitCode(0, 1)).toBe(1);
  });
});
