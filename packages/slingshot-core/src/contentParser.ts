import type { ContentSegment, ParsedContent } from './content';

// --- Token patterns ---------------------------------------------------------
// Order matters when scanning a text run: role mention MUST be tried before
// user mention because `<@&foo>` is a prefix-ambiguous match for `<@...>`.
// Each regex is linear-time and has bounded quantifiers.

const CODE_FENCE_RE = /```([A-Za-z0-9_-]{0,32})?\n([\s\S]*?)```/g;
const CODE_SPAN_RE = /`([^`\n]{1,512})`/g;
const ROLE_MENTION_RE = /<@&([A-Za-z0-9_-]{1,128})>/g;
const USER_MENTION_RE = /<@([A-Za-z0-9_-]{1,128})>/g;
const CONTEXT_REF_RE = /<#([A-Za-z0-9_-]{1,128})>/g;
const EMOJI_RE = /:([a-z][a-z0-9_]{1,31}):/g;
const URL_RE = /https?:\/\/[^\s<>"']{1,2048}/g;

/** Broadcast keywords that take precedence over user-ID mentions. */
const BROADCAST_KEYWORDS = new Set(['everyone', 'here']);

/** Hard caps — defense against pathological input. */
const MAX_BODY_LENGTH = 65_536;
const MAX_SEGMENTS = 4096;

/**
 * Parse content body into segments, extracting inline token references.
 *
 * Walks the body once:
 *   1. Carve out code fences, then code spans — their contents are emitted
 *      as `codeBlock` / `codeSpan` segments and bypass all token scanning.
 *   2. For each remaining text run, scan left-to-right for the earliest
 *      token match (role mention → user mention → context ref → emoji).
 *      Backslash-escaped tokens (`\<@id>`) are passed through as literal
 *      text with the backslash stripped.
 *   3. Collect extracted reference IDs into the result arrays (deduped,
 *      insertion-ordered).
 *
 * The parser is linear in body length and allocates O(segments) memory.
 * Output objects are frozen before return.
 *
 * @param body - The raw body string (plain text or markdown).
 * @returns Frozen `ParsedContent` with segments and extracted references.
 */
export function parseContentTokens(body: string): ParsedContent {
  const segments: ContentSegment[] = [];
  const mentionedUserIds: string[] = [];
  const broadcastMentions: ('everyone' | 'here')[] = [];
  const mentionedRoleIds: string[] = [];
  const referencedContextIds: string[] = [];
  const emojiShortcodes: string[] = [];
  const urls: string[] = [];

  const seenUser = new Set<string>();
  const seenRole = new Set<string>();
  const seenContext = new Set<string>();
  const seenEmoji = new Set<string>();
  const seenUrl = new Set<string>();
  const seenBroadcast = new Set<'everyone' | 'here'>();

  const input = body.length > MAX_BODY_LENGTH ? body.slice(0, MAX_BODY_LENGTH) : body;

  // --- Pass 1: carve code fences and spans ----------------------------------
  type Region =
    | { kind: 'text'; value: string }
    | { kind: 'codeBlock'; value: string; language?: string }
    | { kind: 'codeSpan'; value: string };

  const regions: Region[] = [];
  let cursor = 0;

  // Code fences first (they may contain backticks that code spans would grab).
  const fenceMarkers: { start: number; end: number; language?: string; value: string }[] = [];
  for (const m of input.matchAll(CODE_FENCE_RE)) {
    fenceMarkers.push({
      start: m.index,
      end: m.index + m[0].length,
      language: m[1] || undefined,
      value: m[2],
    });
  }

  for (const fence of fenceMarkers) {
    if (fence.start > cursor) {
      regions.push({ kind: 'text', value: input.slice(cursor, fence.start) });
    }
    regions.push({ kind: 'codeBlock', value: fence.value, language: fence.language });
    cursor = fence.end;
  }
  if (cursor < input.length) {
    regions.push({ kind: 'text', value: input.slice(cursor) });
  }

  // Pass 1b: split text regions on code spans.
  const expanded: Region[] = [];
  for (const region of regions) {
    if (region.kind !== 'text') {
      expanded.push(region);
      continue;
    }
    let sub = 0;
    const text = region.value;
    for (const m of text.matchAll(CODE_SPAN_RE)) {
      if (m.index > sub) {
        expanded.push({ kind: 'text', value: text.slice(sub, m.index) });
      }
      expanded.push({ kind: 'codeSpan', value: m[1] });
      sub = m.index + m[0].length;
    }
    if (sub < text.length) {
      expanded.push({ kind: 'text', value: text.slice(sub) });
    }
  }

  // --- Pass 2: scan text regions for tokens ---------------------------------
  for (const region of expanded) {
    if (segments.length >= MAX_SEGMENTS) break;

    if (region.kind === 'codeBlock') {
      segments.push(
        Object.freeze({
          type: 'codeBlock' as const,
          value: region.value,
          language: region.language,
        }),
      );
      continue;
    }
    if (region.kind === 'codeSpan') {
      segments.push(Object.freeze({ type: 'codeSpan' as const, value: region.value }));
      continue;
    }

    scanTextRun(region.value);
  }

  function scanTextRun(text: string): void {
    let i = 0;
    let buf = '';
    const flushText = () => {
      if (buf.length > 0 && segments.length < MAX_SEGMENTS) {
        segments.push(Object.freeze({ type: 'text' as const, value: buf }));
        buf = '';
      }
    };

    while (i < text.length) {
      const ch = text[i];

      // Backslash escape: consume `\` + next char as literal text.
      if (ch === '\\' && i + 1 < text.length) {
        buf += text[i + 1];
        i += 2;
        continue;
      }

      // URL detection (http(s)://...).
      if ((ch === 'h' || ch === 'H') && i + 7 < text.length) {
        URL_RE.lastIndex = i;
        const m = URL_RE.exec(text);
        if (m && m.index === i) {
          buf += m[0]; // URLs stay in text segments; the markdown renderer autolinks them.
          if (!seenUrl.has(m[0])) {
            seenUrl.add(m[0]);
            urls.push(m[0]);
          }
          i = m.index + m[0].length;
          continue;
        }
      }

      // `<@...>` — user, role, or broadcast mention.
      if (ch === '<' && i + 1 < text.length && text[i + 1] === '@') {
        // Role mention is `<@&id>` — must be tested first.
        ROLE_MENTION_RE.lastIndex = i;
        const role = ROLE_MENTION_RE.exec(text);
        if (role && role.index === i) {
          flushText();
          segments.push(Object.freeze({ type: 'roleMention' as const, roleId: role[1] }));
          if (!seenRole.has(role[1])) {
            seenRole.add(role[1]);
            mentionedRoleIds.push(role[1]);
          }
          i = role.index + role[0].length;
          continue;
        }
        USER_MENTION_RE.lastIndex = i;
        const user = USER_MENTION_RE.exec(text);
        if (user && user.index === i) {
          flushText();
          const id = user[1];
          if (BROADCAST_KEYWORDS.has(id)) {
            const target = id as 'everyone' | 'here';
            segments.push(Object.freeze({ type: 'broadcastMention' as const, target }));
            if (!seenBroadcast.has(target)) {
              seenBroadcast.add(target);
              broadcastMentions.push(target);
            }
          } else {
            segments.push(Object.freeze({ type: 'mention' as const, userId: id }));
            if (!seenUser.has(id)) {
              seenUser.add(id);
              mentionedUserIds.push(id);
            }
          }
          i = user.index + user[0].length;
          continue;
        }
      }

      // `<#contextId>`.
      if (ch === '<' && i + 1 < text.length && text[i + 1] === '#') {
        CONTEXT_REF_RE.lastIndex = i;
        const ref = CONTEXT_REF_RE.exec(text);
        if (ref && ref.index === i) {
          flushText();
          segments.push(Object.freeze({ type: 'contextRef' as const, contextId: ref[1] }));
          if (!seenContext.has(ref[1])) {
            seenContext.add(ref[1]);
            referencedContextIds.push(ref[1]);
          }
          i = ref.index + ref[0].length;
          continue;
        }
      }

      // `:shortcode:`.
      if (ch === ':') {
        EMOJI_RE.lastIndex = i;
        const emoji = EMOJI_RE.exec(text);
        if (emoji && emoji.index === i) {
          flushText();
          segments.push(Object.freeze({ type: 'emoji' as const, shortcode: emoji[1] }));
          if (!seenEmoji.has(emoji[1])) {
            seenEmoji.add(emoji[1]);
            emojiShortcodes.push(emoji[1]);
          }
          i = emoji.index + emoji[0].length;
          continue;
        }
      }

      buf += ch;
      i++;
    }
    flushText();
  }

  const result: ParsedContent = {
    segments: Object.freeze(segments),
    mentionedUserIds: Object.freeze(mentionedUserIds),
    broadcastMentions: Object.freeze(broadcastMentions),
    mentionedRoleIds: Object.freeze(mentionedRoleIds),
    referencedContextIds: Object.freeze(referencedContextIds),
    emojiShortcodes: Object.freeze(emojiShortcodes),
    urls: Object.freeze(urls),
  };
  return Object.freeze(result);
}

/**
 * Strip content tokens from body text for search indexing.
 *
 * Removes `<@userId>`, `<#contextId>`, and `:shortcode:` tokens so that
 * search queries don't match token syntax. Collapses resulting whitespace.
 *
 * @param body - The raw body string.
 * @returns Body with tokens stripped and whitespace normalized.
 */
export function stripContentTokens(body: string): string {
  return body
    .replace(/<@&?[A-Za-z0-9_-]+>/g, '') // user, broadcast, and role mentions
    .replace(/<#[A-Za-z0-9_-]+>/g, '') // context refs
    .replace(/:[a-z][a-z0-9_]{1,31}:/g, '') // emoji shortcodes
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract user IDs from `<@userId>` tokens in body text.
 *
 * Used as a fallback when the client does not provide a `mentions[]` array.
 * Skips tokens inside code blocks and code spans.
 *
 * @param body - The raw body string.
 * @returns Array of unique user IDs (frozen).
 */
export function extractMentionsFromBody(body: string): readonly string[] {
  const parsed = parseContentTokens(body);
  return parsed.mentionedUserIds;
}
