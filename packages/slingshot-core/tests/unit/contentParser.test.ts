import { describe, expect, test } from 'bun:test';
import {
  extractMentionsFromBody,
  parseContentTokens,
  stripContentTokens,
} from '../../src/contentParser';

describe('parseContentTokens', () => {
  test('parses user mentions', () => {
    const result = parseContentTokens('hello <@user-123> world');
    expect(result.mentionedUserIds).toEqual(['user-123']);
    expect(result.segments).toEqual([
      { type: 'text', value: 'hello ' },
      { type: 'mention', userId: 'user-123' },
      { type: 'text', value: ' world' },
    ]);
  });

  test('parses broadcast mentions: everyone and here', () => {
    const result = parseContentTokens('<@everyone> and <@here>');
    expect(result.broadcastMentions).toEqual(['everyone', 'here']);
    expect(result.mentionedUserIds).toEqual([]);
    expect(result.segments[0]).toEqual({ type: 'broadcastMention', target: 'everyone' });
  });

  test('broadcast keywords take priority over user IDs', () => {
    // Even if someone had userId "everyone", the parser emits broadcastMention
    const result = parseContentTokens('<@everyone>');
    expect(result.broadcastMentions).toEqual(['everyone']);
    expect(result.mentionedUserIds).toEqual([]);
  });

  test('parses role mentions with & prefix', () => {
    const result = parseContentTokens('hey <@&role-admin>');
    expect(result.mentionedRoleIds).toEqual(['role-admin']);
    expect(result.segments[1]).toEqual({ type: 'roleMention', roleId: 'role-admin' });
  });

  test('parses context refs', () => {
    const result = parseContentTokens('check <#room-456>');
    expect(result.referencedContextIds).toEqual(['room-456']);
    expect(result.segments[1]).toEqual({ type: 'contextRef', contextId: 'room-456' });
  });

  test('parses custom emoji', () => {
    const result = parseContentTokens('nice :party_parrot:');
    expect(result.emojiShortcodes).toEqual(['party_parrot']);
    expect(result.segments[1]).toEqual({ type: 'emoji', shortcode: 'party_parrot' });
  });

  test('parses URLs', () => {
    const result = parseContentTokens('check https://example.com out');
    expect(result.urls).toEqual(['https://example.com']);
    // URLs stay in text segments
    expect(result.segments[0]).toEqual({ type: 'text', value: 'check https://example.com out' });
  });

  // --- Duplicate dedup ---
  test('duplicate user mention appears twice in segments but once in mentionedUserIds', () => {
    const result = parseContentTokens('<@user-1> and <@user-1>');
    expect(result.mentionedUserIds).toEqual(['user-1']);
    const mentions = result.segments.filter(s => s.type === 'mention');
    expect(mentions).toHaveLength(2);
  });

  test('duplicate URL is deduped in urls array', () => {
    const result = parseContentTokens('https://a.com and https://a.com');
    expect(result.urls).toEqual(['https://a.com']);
  });

  // --- Code block suppression ---
  test('tokens inside code fences are not parsed', () => {
    const result = parseContentTokens('```\n<@user-1>\n```');
    expect(result.mentionedUserIds).toEqual([]);
    expect(result.segments[0]).toEqual({
      type: 'codeBlock',
      value: '<@user-1>\n',
      language: undefined,
    });
  });

  test('tokens inside code spans are not parsed', () => {
    const result = parseContentTokens('inline `<@user-1>` code');
    expect(result.mentionedUserIds).toEqual([]);
    expect(result.segments[1]).toEqual({ type: 'codeSpan', value: '<@user-1>' });
  });

  test('code fence with language tag', () => {
    const result = parseContentTokens('```js\nconst x = 1;\n```');
    expect(result.segments[0]).toEqual({
      type: 'codeBlock',
      value: 'const x = 1;\n',
      language: 'js',
    });
  });

  // --- Escape handling ---
  test('backslash-escaped mention is literal text without backslash', () => {
    const result = parseContentTokens('\\<@user-1>');
    expect(result.mentionedUserIds).toEqual([]);
    // The backslash is consumed, '<' is literal, then @user-1> is literal text
    expect(result.segments.length).toBeGreaterThan(0);
    const text = result.segments.map(s => (s.type === 'text' ? s.value : '')).join('');
    expect(text).toContain('<');
  });

  // --- Edge cases ---
  test('empty string returns empty result', () => {
    const result = parseContentTokens('');
    expect(result.segments).toEqual([]);
    expect(result.mentionedUserIds).toEqual([]);
  });

  test('bare @john is NOT a mention (no angle brackets)', () => {
    const result = parseContentTokens('hey @john');
    expect(result.mentionedUserIds).toEqual([]);
    expect(result.segments).toEqual([{ type: 'text', value: 'hey @john' }]);
  });

  test('emoji shortcode must start with a letter', () => {
    // `:123:` should NOT match
    const result = parseContentTokens(':123:');
    expect(result.emojiShortcodes).toEqual([]);
  });

  test('single colon in time like 2:30pm does not match', () => {
    const result = parseContentTokens('meet at 2:30pm');
    expect(result.emojiShortcodes).toEqual([]);
  });

  test('output is frozen', () => {
    const result = parseContentTokens('hello <@user-1>');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.segments)).toBe(true);
    expect(Object.isFrozen(result.mentionedUserIds)).toBe(true);
  });

  // --- Adversarial input ---
  test('long input is truncated', () => {
    const longInput = 'a'.repeat(100_000);
    const result = parseContentTokens(longInput);
    expect(result.segments.length).toBeGreaterThan(0);
  });

  test('repeated incomplete mention tokens', () => {
    const input = '<@'.repeat(10_000);
    const result = parseContentTokens(input);
    expect(result.mentionedUserIds).toEqual([]);
  });

  // --- Mixed content ---
  test('parses complex mixed content', () => {
    const body = 'hey <@user-123> check **this** https://example.com and :wave: in <#room-1>';
    const result = parseContentTokens(body);
    expect(result.mentionedUserIds).toEqual(['user-123']);
    expect(result.urls).toEqual(['https://example.com']);
    expect(result.emojiShortcodes).toEqual(['wave']);
    expect(result.referencedContextIds).toEqual(['room-1']);
  });
});

describe('stripContentTokens', () => {
  test('strips mentions', () => {
    expect(stripContentTokens('hello <@user-1> world')).toBe('hello world');
  });

  test('strips role mentions', () => {
    expect(stripContentTokens('hello <@&admin> world')).toBe('hello world');
  });

  test('strips context refs', () => {
    expect(stripContentTokens('check <#room-1>')).toBe('check');
  });

  test('strips emoji shortcodes', () => {
    expect(stripContentTokens('nice :wave: bro')).toBe('nice bro');
  });

  test('collapses whitespace', () => {
    expect(stripContentTokens('a  <@u>  b')).toBe('a b');
  });
});

describe('extractMentionsFromBody', () => {
  test('extracts mentions from body as fallback', () => {
    const result = extractMentionsFromBody('hello <@user-1> and <@user-2>');
    expect(result).toEqual(['user-1', 'user-2']);
  });

  test('skips mentions in code blocks', () => {
    const result = extractMentionsFromBody('```\n<@user-1>\n```');
    expect(result).toEqual([]);
  });

  test('returns frozen array', () => {
    const result = extractMentionsFromBody('<@user-1>');
    expect(Object.isFrozen(result)).toBe(true);
  });
});
