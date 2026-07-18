/**
 * Moderation.
 *
 * The tests that matter here are the ones where a naive implementation would
 * quietly ALLOW something. A moderator that blocks correctly on the happy path
 * but fails open when the judge times out, or drops an item, or gets a policy
 * name it doesn't know, is not a safety control — it is the appearance of one,
 * which is worse, because the app stops looking.
 */
import { describe, expect, test } from 'bun:test';
import { type AiPackageConfigInput, aiPackageConfigSchema } from '../../src/config';
import { createAiClient } from '../../src/lib/client';
import { messageContentText } from '../../src/lib/messageContent';
import { createFakeAiProvider } from '../../src/testing';
import type { AiModerator } from '../../src/types';

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** A provider whose "generation" is really the judge answering. */
function judge(verdicts: { index: number; severity: string; reason?: string }[]) {
  return createFakeAiProvider({
    capabilities: { structuredOutput: 'native', maxOutputTokens: 4096 },
    handler: () => ({
      text: JSON.stringify({
        items: verdicts.map(v => ({
          index: v.index,
          allowed: v.severity === 'none',
          categories: v.severity === 'none' ? [] : ['nsfw'],
          severity: v.severity,
          reason: v.reason ?? 'because',
        })),
      }),
    }),
  });
}

const POLICY = {
  rules: 'No explicit sexual content.',
  categories: ['nsfw'],
  blockAtOrAbove: 'medium' as const,
};

/**
 * `moderation` is deliberately loosened to a partial: every test here overrides
 * one field of it and relies on `build` merging the policies back in. Typing it
 * as the full config forced an `as never` at each call site, which is a cast that
 * would have hidden a genuine type error just as happily as a spurious one.
 */
type BuildOverrides = Omit<Partial<AiPackageConfigInput>, 'moderation'> & {
  moderation?: Partial<NonNullable<AiPackageConfigInput['moderation']>>;
};

function build(provider: ReturnType<typeof createFakeAiProvider>, overrides: BuildOverrides = {}) {
  const { moderation, ...rest } = overrides;
  const config = aiPackageConfigSchema.parse({
    providers: { test: { provider } },
    defaultProvider: 'test',
    ...rest,
    // Merged last so a test's partial `moderation` override keeps the policies.
    moderation: { policies: { house: POLICY }, ...(moderation ?? {}) },
  });
  return createAiClient({
    config,
    providers: new Map([['test', provider]]),
    logger: silentLogger,
  });
}

describe('moderation', () => {
  test('blocks at or above the configured severity, and allows below it', async () => {
    const { moderator } = build(
      judge([
        { index: 0, severity: 'none' },
        { index: 1, severity: 'low' },
        { index: 2, severity: 'high' },
      ]),
    );

    const verdict = await moderator.moderate({
      content: ['clean', 'edgy', 'explicit'],
      policy: 'house',
    });

    expect(verdict.allowed).toBe(false);
    // `blockAtOrAbove: 'medium'` — so 'low' passes. The threshold is the knob
    // that decides, not the model's own `allowed` field; otherwise configuring
    // it would do nothing while looking like it worked.
    expect(verdict.items!.map(i => i.allowed)).toEqual([true, true, false]);
    expect(verdict.severity).toBe('high');
    expect(verdict.categories).toContain('nsfw');
  });

  test('FAILS CLOSED when the judge throws', async () => {
    const broken = createFakeAiProvider({
      capabilities: { structuredOutput: 'native' },
      responses: [{ error: new Error('judge exploded') }],
    });
    const { moderator } = build(broken);

    const verdict = await moderator.moderate({ content: ['anything'], policy: 'house' });

    // Blocked, not allowed. The judge broke; we do not get to assume the content
    // was fine.
    expect(verdict.allowed).toBe(false);
    expect(verdict.categories).toContain('moderation-error');
    expect(verdict.reason).toMatch(/moderation failed/);
  });

  test("FAILS OPEN only when onError: 'allow' is explicitly chosen", async () => {
    const broken = createFakeAiProvider({
      capabilities: { structuredOutput: 'native' },
      responses: [{ error: new Error('judge exploded') }],
    });
    const { moderator } = build(broken, { moderation: { onError: 'allow' } });

    const verdict = await moderator.moderate({ content: ['anything'], policy: 'house' });
    expect(verdict.allowed).toBe(true);
  });

  test('an item the judge silently dropped is BLOCKED, not waved through', async () => {
    // A dropped item is exactly what a prompt-injected payload would try to
    // cause. "Missing" must never read as "fine".
    const { moderator } = build(judge([{ index: 0, severity: 'none' }]));

    const verdict = await moderator.moderate({
      content: ['first', 'second-gets-no-verdict'],
      policy: 'house',
    });

    expect(verdict.allowed).toBe(false);
    expect(verdict.items![1]!.allowed).toBe(false);
    expect(verdict.items![1]!.reason).toMatch(/no verdict/);
  });

  test('an unknown policy name throws rather than becoming "no moderation"', async () => {
    const { moderator } = build(judge([]));

    await expect(
      moderator.moderate({ content: ['x'], policy: 'typo-in-the-policy-name' }),
    ).rejects.toThrow(/policy 'typo-in-the-policy-name' is not defined/);
  });

  test('batches large inputs into maxBatchSize calls', async () => {
    const provider = createFakeAiProvider({
      capabilities: { structuredOutput: 'native' },
      handler: req => {
        // Answer whatever indices this batch actually asked about.
        const asked = [...messageContentText(req.messages[0]!.content).matchAll(/\[(\d+)\]/g)].map(
          m => Number(m[1]),
        );
        return {
          text: JSON.stringify({
            items: asked.map(index => ({
              index,
              allowed: true,
              categories: [],
              severity: 'none',
              reason: 'ok',
            })),
          }),
        };
      },
    });
    const { moderator } = build(provider, { moderation: { maxBatchSize: 2 } });

    const verdict = await moderator.moderate({
      content: ['a', 'b', 'c', 'd', 'e'],
      policy: 'house',
    });

    expect(verdict.allowed).toBe(true);
    expect(verdict.items).toHaveLength(5);
    // 5 items / batch of 2 = 3 calls.
    expect(provider.calls).toHaveLength(3);
  });

  test('the judge may run on a DIFFERENT provider than the generator', async () => {
    // The headline capability: generate on a free local model, judge on a
    // trusted one for a fraction of a cent.
    const generator = createFakeAiProvider({ name: 'local', responses: ['a generated card'] });
    const cheapJudge = judge([{ index: 0, severity: 'high' }]);

    const config = aiPackageConfigSchema.parse({
      providers: { local: { provider: generator }, haiku: { provider: cheapJudge } },
      defaultProvider: 'local',
      moderation: { provider: 'haiku', policies: { house: POLICY } },
    });
    const { client } = createAiClient({
      config,
      providers: new Map([
        ['local', generator],
        ['haiku', cheapJudge],
      ]),
      logger: silentLogger,
    });

    const result = await client.generate({
      messages: [{ role: 'user', content: 'make a card' }],
      moderation: { policy: 'house' },
    });

    expect(result.provider).toBe('local');
    expect(result.moderation?.allowed).toBe(false);
    // The generator was never asked to judge itself.
    expect(cheapJudge.calls).toHaveLength(1);
    expect(generator.calls).toHaveLength(1);
  });

  test('the judging call is never itself moderated (no infinite recursion)', async () => {
    const provider = judge([{ index: 0, severity: 'none' }]);
    const { client } = build(provider);

    await client.generate({
      messages: [{ role: 'user', content: 'go' }],
      moderation: { policy: 'house' },
    });

    // One generation + exactly one judging call. If the judge's own call were
    // moderated, this would not terminate.
    expect(provider.calls).toHaveLength(2);
  });

  test('a custom moderator wins outright (the non-LLM swap point)', async () => {
    const custom: AiModerator = {
      moderate: async () => ({
        allowed: false,
        categories: ['blocklist'],
        severity: 'high',
        reason: 'matched a local blocklist',
        usage: null,
        strategy: 'independent',
      }),
      policies: () => ['house'],
    };

    const provider = judge([{ index: 0, severity: 'none' }]);
    const { moderator } = build(provider, { moderation: { moderator: custom } });

    const verdict = await moderator.moderate({ content: ['x'], policy: 'house' });
    expect(verdict.categories).toContain('blocklist');
    // No LLM call at all — a local classifier costs nothing.
    expect(provider.calls).toHaveLength(0);
    expect(verdict.usage).toBeNull();
  });
});
