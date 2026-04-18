import { describe, expect, it } from 'bun:test';
import { matchGlob } from '../../src/lib/globMatch';

describe('matchGlob', () => {
  it('exact match without wildcard', () => {
    expect(matchGlob('auth:user.created', 'auth:user.created')).toBe(true);
    expect(matchGlob('auth:user.created', 'auth:user.deleted')).toBe(false);
  });

  it('* matches dots and colons', () => {
    expect(matchGlob('security.*', 'security.auth.login.success')).toBe(true);
    expect(matchGlob('auth:*', 'auth:user.created')).toBe(true);
    expect(matchGlob('community:*', 'community:thread.published')).toBe(true);
  });

  it('* does not match across prefix boundary (no anchor escape needed)', () => {
    // 'auth:*' should NOT match 'security.auth.login.success'
    expect(matchGlob('auth:*', 'security.auth.login.success')).toBe(false);
  });

  it('wildcard-only pattern matches everything', () => {
    expect(matchGlob('*', 'auth:user.created')).toBe(true);
    expect(matchGlob('*', 'security.auth.login.success')).toBe(true);
  });

  it('no match on partial prefix', () => {
    expect(matchGlob('auth:user.*', 'auth:user.created')).toBe(true);
    expect(matchGlob('auth:user.*', 'auth:account.locked')).toBe(false);
  });

  it('empty pattern does not match non-empty string', () => {
    expect(matchGlob('', 'auth:user.created')).toBe(false);
    expect(matchGlob('', '')).toBe(true);
  });
});
