/**
 * `@lastshotlabs/slingshot-ai/testing`
 *
 * Two things live here, and the second one is the important one:
 *
 * 1. `createFakeAiProvider()` — a provider you fully control, so an app's AI
 *    code can be tested hermetically. No network, no key, no cost, no flake.
 *
 * 2. `runProviderConformanceSuite()` — the contract every real adapter must
 *    pass. This is what makes "swap the provider in config" a claim rather than
 *    a hope: the Anthropic adapter, the openai-compatible adapter, and this fake
 *    all run the same suite, so a behavior the orchestrator relies on cannot
 *    quietly differ between them.
 */
import { describe, expect, test } from 'bun:test';
import { CONSERVATIVE_CAPABILITIES } from './provider/capabilities';
import type {
  AiProvider,
  NormalizedRequest,
  ProviderCapabilities,
  ProviderResult,
  ProviderStream,
  ProviderStreamEvent,
} from './provider/types';
import type { AiModerator, AiVerdict } from './types';

// ---------------------------------------------------------------------------
// Fake provider
// ---------------------------------------------------------------------------

/** A canned response. A bare string is shorthand for `{ text }`. */
export type FakeResponse =
  | string
  | {
      text?: string;
      /** The provider's ADVISORY structured value (what a native provider would return). */
      structured?: unknown;
      stopReason?: ProviderResult['stopReason'];
      usage?: Partial<ProviderResult['usage']>;
      /** Throw instead of responding — for retry/error-path tests. */
      error?: Error;
    };

export interface FakeAiProviderOptions {
  readonly kind?: string;
  readonly name?: string;
  readonly defaultModel?: string;
  /**
   * Capability overrides. The default is CONSERVATIVE (no structured output, no
   * caching, no cost accounting) — a fake that claims everything works would
   * hide exactly the degradation paths you want tested. Set
   * `{ structuredOutput: 'none' }` explicitly to exercise the repair loop.
   */
  readonly capabilities?: Partial<ProviderCapabilities>;
  /** Responses in order. The last one repeats once exhausted. */
  readonly responses?: readonly FakeResponse[];
  /** Full control: compute a response from the request. */
  readonly handler?: (req: NormalizedRequest, callIndex: number) => FakeResponse;
  /** Respond based on what's in the prompt. First matching entry wins. */
  readonly match?: readonly { readonly when: RegExp; readonly respond: FakeResponse }[];
}

export interface FakeAiProvider extends AiProvider {
  /** Every request this provider received, in order. Assert against it. */
  readonly calls: readonly NormalizedRequest[];
  reset(): void;
}

interface NormalizedFakeResponse {
  readonly text: string;
  readonly structured: unknown;
  readonly stopReason: ProviderResult['stopReason'];
  readonly usage: ProviderResult['usage'];
  readonly error?: Error;
}

function normalize(response: FakeResponse): NormalizedFakeResponse {
  const source = typeof response === 'string' ? { text: response } : response;
  const normalized: NormalizedFakeResponse = {
    text: source.text ?? '',
    structured: source.structured,
    stopReason: source.stopReason ?? 'end',
    usage: {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      ...source.usage,
    },
    error: source.error,
  };
  return normalized;
}

export function createFakeAiProvider(options: FakeAiProviderOptions = {}): FakeAiProvider {
  const calls: NormalizedRequest[] = [];
  const capabilities: ProviderCapabilities = {
    ...CONSERVATIVE_CAPABILITIES,
    ...options.capabilities,
  };
  let index = 0;

  function pick(req: NormalizedRequest): FakeResponse {
    if (options.handler) return options.handler(req, index);

    if (options.match) {
      const haystack = [
        ...req.system.map(block => block.text),
        ...req.messages.map(message => message.content),
      ].join('\n');
      const hit = options.match.find(entry => entry.when.test(haystack));
      if (hit) return hit.respond;
    }

    const list = options.responses ?? [];
    if (list.length === 0) return '';
    return list[Math.min(index, list.length - 1)] as FakeResponse;
  }

  async function generate(req: NormalizedRequest): Promise<ProviderResult> {
    calls.push(req);
    const chosen = normalize(pick(req));
    index++;
    if (chosen.error) throw chosen.error;
    return {
      text: chosen.text,
      structured: chosen.structured,
      stopReason: chosen.stopReason,
      usage: chosen.usage,
      raw: { fake: true },
    };
  }

  return {
    kind: options.kind ?? 'fake',
    name: options.name ?? 'fake',
    defaultModel: options.defaultModel ?? 'fake-model-1',
    capabilities,
    calls,
    generate,

    stream(req: NormalizedRequest): ProviderStream {
      const resultPromise = generate(req);
      return {
        async *[Symbol.asyncIterator](): AsyncIterator<ProviderStreamEvent> {
          const result = await resultPromise;
          // Deliberately chunked, so the concat invariant is actually exercised.
          for (const word of result.text.split(/(?<=\s)/)) {
            if (word) yield { type: 'text', delta: word };
          }
        },
        finalResult: () => resultPromise,
      };
    },

    async countTokens(req: NormalizedRequest): Promise<number> {
      const text = [
        ...req.system.map(block => block.text),
        ...req.messages.map(message => message.content),
      ].join('');
      return Math.ceil(text.length / 4);
    },

    reset(): void {
      calls.length = 0;
      index = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Fake moderator
// ---------------------------------------------------------------------------

export interface ScriptedModeratorOptions {
  /** Anything matching is blocked. Everything else is allowed. */
  readonly block?: RegExp;
  readonly policies?: readonly string[];
  readonly onModerate?: (content: readonly string[], policy: string) => void;
}

export function scriptedModerator(options: ScriptedModeratorOptions = {}): AiModerator {
  return {
    async moderate({ content, policy }): Promise<AiVerdict> {
      const items = Array.isArray(content) ? [...content] : [content as string];
      options.onModerate?.(items, policy);

      const itemVerdicts = items.map((text, itemIndex) => {
        const blocked = options.block ? options.block.test(text) : false;
        return {
          index: itemIndex,
          allowed: !blocked,
          categories: blocked ? ['test-blocked'] : [],
          severity: (blocked ? 'high' : 'none') as AiVerdict['severity'],
          reason: blocked ? 'matched the scripted block pattern' : 'ok',
        };
      });
      const allowed = itemVerdicts.every(verdict => verdict.allowed);

      return {
        allowed,
        categories: allowed ? [] : ['test-blocked'],
        severity: allowed ? 'none' : 'high',
        reason: allowed ? 'ok' : 'matched the scripted block pattern',
        items: itemVerdicts,
        usage: null,
        strategy: 'independent',
      };
    },
    policies() {
      return options.policies ?? ['default'];
    },
  };
}

// ---------------------------------------------------------------------------
// Conformance suite
// ---------------------------------------------------------------------------

function baseRequest(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    model: 'conformance-model',
    system: [{ text: 'You are a test fixture.', cache: false }],
    messages: [{ role: 'user', content: 'Say hello.' }],
    maxTokens: 256,
    timeoutMs: 30_000,
    ...overrides,
  };
}

/**
 * The provider contract, as executable assertions.
 *
 * Every adapter runs this. The suite deliberately asserts only what the
 * ORCHESTRATOR depends on — it does not tell an adapter how to be implemented,
 * it tells it what it must never do. In particular:
 *
 *   - capabilities must be honest and self-consistent (an `explicit` prompt
 *     cache without a stated minimum is the bug that silently costs 10x)
 *   - usage counts must be present and non-negative, even if zero
 *   - the streaming concat invariant must hold: the deltas ARE the final text.
 *     Anything else means a streaming UI and a saved transcript disagree.
 */
export function runProviderConformanceSuite(
  name: string,
  factory: () => AiProvider | Promise<AiProvider>,
): void {
  describe(`provider conformance: ${name}`, () => {
    test('declares an identity', async () => {
      const provider = await factory();
      expect(provider.kind).toBeTruthy();
      expect(provider.name).toBeTruthy();
      expect(provider.defaultModel).toBeTruthy();
    });

    test('declares self-consistent capabilities', async () => {
      const { capabilities } = await factory();

      expect(['native', 'json-mode', 'none']).toContain(capabilities.structuredOutput);
      expect(['explicit', 'automatic', 'none']).toContain(capabilities.promptCaching);
      expect(['adaptive', 'budget', 'none']).toContain(capabilities.thinking);
      expect(['full', 'partial', 'none']).toContain(capabilities.usageAccounting);
      expect(capabilities.maxOutputTokens).toBeGreaterThan(0);

      // The high-value one: a provider that says it supports explicit prompt
      // caching MUST say what the minimum cacheable prefix is. Below that
      // minimum the API accepts a breakpoint and then silently does not cache,
      // so without this number the orchestrator cannot tell you that your cache
      // is doing nothing.
      if (capabilities.promptCaching === 'explicit') {
        expect(capabilities.promptCacheMinTokens).toBeGreaterThan(0);
      }
    });

    test('generate() returns text, a stop reason, and usage', async () => {
      const provider = await factory();
      const result = await provider.generate(baseRequest());

      expect(typeof result.text).toBe('string');
      expect(['end', 'max_tokens', 'refusal', 'tool_use', 'unknown']).toContain(result.stopReason);

      expect(result.usage.inputTokens).toBeGreaterThanOrEqual(0);
      expect(result.usage.outputTokens).toBeGreaterThanOrEqual(0);
      expect(result.usage.cacheReadTokens).toBeGreaterThanOrEqual(0);
      expect(result.usage.cacheWriteTokens).toBeGreaterThanOrEqual(0);
    });

    test('stream() deltas concatenate to exactly finalResult().text', async () => {
      const provider = await factory();
      if (!provider.capabilities.streaming) return;

      const stream = provider.stream(baseRequest());
      let accumulated = '';
      for await (const event of stream) {
        if (event.type === 'text') accumulated += event.delta;
      }
      const final = await stream.finalResult();

      // If this fails, a user watching the stream and a database row holding the
      // saved answer contain different text — and nothing anywhere reports it.
      expect(accumulated).toBe(final.text);
    });

    test('countTokens(), if implemented, returns a non-negative number', async () => {
      const provider = await factory();
      if (!provider.countTokens) return;
      expect(await provider.countTokens(baseRequest())).toBeGreaterThanOrEqual(0);
    });

    test('priceFor(), if implemented, returns a price or an honest null', async () => {
      const provider = await factory();
      if (!provider.priceFor) return;

      const price = provider.priceFor('a-model-that-does-not-exist');
      // `null` is the REQUIRED answer for an unknown model. Fabricating a price
      // is how a cost dashboard becomes fiction.
      expect(price === null || typeof price?.inputPerMTok === 'number').toBe(true);
    });
  });
}
