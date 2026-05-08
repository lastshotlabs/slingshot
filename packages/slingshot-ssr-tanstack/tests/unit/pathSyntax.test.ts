import { describe, expect, it } from 'bun:test';
import { translatePath } from '../../src/pathSyntax';

describe('translatePath', () => {
  it('root layout has no URL', () => {
    const r = translatePath('__root');
    expect(r.isRoot).toBe(true);
    expect(r.urlPattern).toBe('');
  });

  it('plain index → /', () => {
    const r = translatePath('index');
    expect(r.urlPattern).toBe('/');
    expect(r.regex.test('/')).toBe(true);
    expect(r.regex.test('/foo')).toBe(false);
  });

  it('pathless ancestors do not contribute to URL', () => {
    const r = translatePath('_app/_feed/index');
    expect(r.urlPattern).toBe('/');
    expect(r.pathlessAncestors).toEqual(['_app', '_feed']);
  });

  it('directory + file → URL', () => {
    const r = translatePath('_app/dm/index');
    expect(r.urlPattern).toBe('/dm');
    expect(r.regex.test('/dm')).toBe(true);
    expect(r.pathlessAncestors).toEqual(['_app']);
  });

  it('dynamic params translate $name → :name', () => {
    const r = translatePath('_app/c/$slug/$threadId');
    expect(r.urlPattern).toBe('/c/:slug/:threadId');
    expect(r.paramNames).toEqual(['slug', 'threadId']);
    const m = r.regex.exec('/c/foo-room/123');
    expect(m).not.toBeNull();
    expect(m?.groups?.slug).toBe('foo-room');
    expect(m?.groups?.threadId).toBe('123');
  });

  it('flat-format dot-separated filenames expand to slashes', () => {
    const r = translatePath('_app/user.$handle');
    expect(r.urlPattern).toBe('/user/:handle');
    expect(r.paramNames).toEqual(['handle']);
    expect(r.regex.test('/user/jdd')).toBe(true);
  });

  it('multiple pathless ancestors stack', () => {
    const r = translatePath('_guest/auth/login');
    expect(r.urlPattern).toBe('/auth/login');
    expect(r.pathlessAncestors).toEqual(['_guest']);
  });

  it('throws on $ catch-all (v1)', () => {
    expect(() => translatePath('$')).toThrow(/catch-all/);
  });

  it('throws on empty $ param name', () => {
    expect(() => translatePath('_app/$')).toThrow(/catch-all/);
  });

  it('regex anchors fully — partial matches rejected', () => {
    const r = translatePath('_app/dm/index');
    expect(r.regex.test('/dm')).toBe(true);
    expect(r.regex.test('/dm/foo')).toBe(false);
    expect(r.regex.test('foo/dm')).toBe(false);
  });
});
