/**
 * The orchestrator's tool loop.
 *
 * The theme of this file is the same as `orchestrator.test.ts`: every case here
 * is one where a naive implementation succeeds quietly with a worse result. A
 * tool loop has more of those than anything else in the package, because the
 * MODEL decides how many times to go round — so the failure modes are "spends
 * forever", "silently stops early", and "runs whatever the model asked for".
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { type AiPackageConfigInput, aiPackageConfigSchema } from '../../src/config';
import { AiConfigError, AiUnsupportedFeatureError } from '../../src/errors';
import { createAiClient } from '../../src/lib/client';
import { messageContentText, messageContentUnits } from '../../src/lib/messageContent';
import type { ProviderToolCall } from '../../src/provider/types';
import { createFakeAiProvider } from '../../src/testing';
import type { AiClient, AiStreamEvent, AiTool } from '../../src/types';

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const TOOL_CAPABLE = { toolUse: true, streaming: true } as const;

function build(
  provider: ReturnType<typeof createFakeAiProvider>,
  overrides: Partial<AiPackageConfigInput> = {},
): { client: AiClient; usage: ReturnType<typeof createAiClient>['usage'] } {
  const config = aiPackageConfigSchema.parse({
    providers: { test: { provider } },
    defaultProvider: 'test',
    ...overrides,
  });
  const { client, usage } = createAiClient({
    config,
    providers: new Map([['test', provider]]),
    logger: silentLogger,
  });
  return { client, usage };
}

const ask = { messages: [{ role: 'user' as const, content: 'How is my squat trending?' }] };

const call = (name: string, args: string, id = 'call_1'): ProviderToolCall => ({
  id,
  name,
  argumentsJson: args,
});

/** The tool result text sent back on a given iteration, for asserting what the model saw. */
function toolResultText(
  provider: ReturnType<typeof createFakeAiProvider>,
  iteration: number,
): string {
  const content = provider.calls[iteration]?.messages.at(-1)?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(part => part.type === 'tool_result')
    .map(part => String((part as { result: unknown }).result))
    .join('\n');
}

/** A tool that records what it was handed. */
function recordingTool(overrides: Partial<AiTool<{ lift: string }>> = {}): {
  tool: AiTool<{ lift: string }>;
  seen: { lift: string }[];
} {
  const seen: { lift: string }[] = [];
  const tool: AiTool<{ lift: string }> = {
    name: 'get_lift_trend',
    description: 'Trend for one lift.',
    schema: z.object({ lift: z.string() }),
    async execute(args) {
      seen.push(args);
      return { lift: args.lift, changeKg: 12 };
    },
    ...overrides,
  };
  return { tool, seen };
}

describe('the loop', () => {
  test('calls the tool, feeds the result back, and finishes', async () => {
    const { tool, seen } = recordingTool();
    const provider = createFakeAiProvider({
      capabilities: TOOL_CAPABLE,
      responses: [
        { text: 'Let me check. ', toolCalls: [call('get_lift_trend', '{"lift":"squat"}')] },
        { text: "You're up 12kg." },
      ],
    });
    const { client } = build(provider);

    const result = await client.generate({ ...ask, tools: [tool] });

    expect(seen).toEqual([{ lift: 'squat' }]);
    expect(provider.calls).toHaveLength(2);
    expect(result.iterations).toBe(2);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.ok).toBe(true);
    expect(result.toolCalls[0]!.args).toEqual({ lift: 'squat' });
    expect(result.degradations.map(d => d.feature)).not.toContain('toolUse');
  });

  test('value is EVERY assistant turn, not just the last', async () => {
    // The last-turn-only reading breaks the streaming invariant outright: the
    // user already watched "Let me check." go past, and a transcript that omits
    // it disagrees with the screen.
    const { tool } = recordingTool();
    const { client } = build(
      createFakeAiProvider({
        capabilities: TOOL_CAPABLE,
        responses: [
          { text: 'Let me check. ', toolCalls: [call('get_lift_trend', '{"lift":"squat"}')] },
          { text: "You're up 12kg." },
        ],
      }),
    );

    const result = await client.generate({ ...ask, tools: [tool] });
    expect(result.value).toBe("Let me check. You're up 12kg.");
  });

  test('the second iteration carries the assistant call and the tool result', async () => {
    const { tool } = recordingTool();
    const provider = createFakeAiProvider({
      capabilities: TOOL_CAPABLE,
      responses: [{ toolCalls: [call('get_lift_trend', '{"lift":"squat"}')] }, { text: 'done' }],
    });
    const { client } = build(provider);

    await client.generate({ ...ask, tools: [tool] });

    const second = provider.calls[1]!;
    expect(second.messages).toHaveLength(3);
    expect(second.messages[1]).toEqual({
      role: 'assistant',
      content: [
        {
          type: 'tool_call',
          id: 'call_1',
          name: 'get_lift_trend',
          argumentsJson: '{"lift":"squat"}',
        },
      ],
    });
    expect(second.messages[2]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          id: 'call_1',
          name: 'get_lift_trend',
          result: { lift: 'squat', changeKg: 12 },
        },
      ],
    });
    // The tools ride every iteration — a model that lost them mid-loop could not
    // ask a follow-up question.
    expect(second.tools?.[0]?.name).toBe('get_lift_trend');
  });

  test('runs several calls from one turn concurrently', async () => {
    let concurrent = 0;
    let peak = 0;
    const slow: AiTool<{ lift: string }> = {
      name: 'get_lift_trend',
      description: 'x',
      schema: z.object({ lift: z.string() }),
      async execute(args) {
        concurrent++;
        peak = Math.max(peak, concurrent);
        await Bun.sleep(5);
        concurrent--;
        return args.lift;
      },
    };
    const { client } = build(
      createFakeAiProvider({
        capabilities: TOOL_CAPABLE,
        responses: [
          {
            toolCalls: [
              call('get_lift_trend', '{"lift":"squat"}', 'a'),
              call('get_lift_trend', '{"lift":"bench"}', 'b'),
            ],
          },
          { text: 'done' },
        ],
      }),
    );

    const result = await client.generate({ ...ask, tools: [slow] });
    expect(peak).toBe(2);
    expect(result.toolCalls.map(c => c.id)).toEqual(['a', 'b']);
  });
});

describe('arguments are validated in the orchestrator, never trusted', () => {
  test('unparseable arguments become an isError result the model can fix', async () => {
    const { tool, seen } = recordingTool();
    const provider = createFakeAiProvider({
      capabilities: TOOL_CAPABLE,
      responses: [
        { toolCalls: [call('get_lift_trend', '{"lift": squat')] },
        { text: 'sorry about that' },
      ],
    });
    const { client } = build(provider);

    const result = await client.generate({ ...ask, tools: [tool] });

    expect(seen).toEqual([]);
    expect(result.toolCalls[0]!.ok).toBe(false);
    expect(toolResultText(provider, 1)).toMatch(/not valid JSON/);
  });

  test('a schema violation is caught here, not inside the tool', async () => {
    // This is invariant 1 applied to tools: a vendor claiming strict function
    // schemas is making exactly the claim we already refuse to take on trust for
    // a response schema — and this one is about to reach an app's DB write.
    const { tool, seen } = recordingTool();
    const provider = createFakeAiProvider({
      capabilities: TOOL_CAPABLE,
      responses: [{ toolCalls: [call('get_lift_trend', '{"lift":42}')] }, { text: 'fixed' }],
    });
    const { client } = build(provider);

    const result = await client.generate({ ...ask, tools: [tool] });

    expect(seen).toEqual([]);
    expect(result.toolCalls[0]!.ok).toBe(false);
    expect(toolResultText(provider, 1)).toMatch(/did not match its schema/);
    expect(toolResultText(provider, 1)).toMatch(/lift/);
  });

  test('an unknown tool name is an isError result naming the real tools, never a throw', async () => {
    const { tool } = recordingTool();
    const provider = createFakeAiProvider({
      capabilities: TOOL_CAPABLE,
      responses: [{ toolCalls: [call('delete_everything', '{}')] }, { text: 'my mistake' }],
    });
    const { client } = build(provider);

    const result = await client.generate({ ...ask, tools: [tool] });

    expect(result.value).toBe('my mistake');
    expect(result.toolCalls[0]!.ok).toBe(false);
    // The only place a hallucinated capability can be corrected is the
    // conversation, so the correction goes there — with the real list attached.
    expect(toolResultText(provider, 1)).toMatch(/Unknown tool 'delete_everything'/);
    expect(toolResultText(provider, 1)).toMatch(/get_lift_trend/);
  });

  test('a throwing tool becomes an isError result and does not kill the turn', async () => {
    const exploding: AiTool<{ lift: string }> = {
      name: 'get_lift_trend',
      description: 'x',
      schema: z.object({ lift: z.string() }),
      execute() {
        return Promise.reject(new Error('no sessions in range'));
      },
    };
    const provider = createFakeAiProvider({
      capabilities: TOOL_CAPABLE,
      responses: [
        { toolCalls: [call('get_lift_trend', '{"lift":"squat"}')] },
        { text: 'There is no data for that lift yet.' },
      ],
    });
    const { client } = build(provider);

    const result = await client.generate({ ...ask, tools: [exploding] });

    expect(result.value).toBe('There is no data for that lift yet.');
    expect(result.toolCalls[0]!.ok).toBe(false);
    expect(toolResultText(provider, 1)).toMatch(/no sessions in range/);
  });

  test('a tool is never retried', async () => {
    // Retry policy for a side-effecting app function is the app's business.
    // Silently re-running a write tool is not a behavior a framework may choose.
    let runs = 0;
    const failing: AiTool<Record<string, never>> = {
      name: 'log_workout',
      description: 'x',
      schema: z.object({}),
      execute() {
        runs++;
        return Promise.reject(new Error('boom'));
      },
    };
    const { client } = build(
      createFakeAiProvider({
        capabilities: TOOL_CAPABLE,
        responses: [{ toolCalls: [call('log_workout', '{}')] }, { text: 'ok' }],
      }),
    );

    await client.generate({ ...ask, tools: [failing] });
    expect(runs).toBe(1);
  });
});

describe('bounding', () => {
  test('hitting maxToolIterations is a DEGRADATION, not a silent truncation', async () => {
    const { tool } = recordingTool();
    // A model that never stops asking.
    const provider = createFakeAiProvider({
      capabilities: TOOL_CAPABLE,
      handler: () => ({ toolCalls: [call('get_lift_trend', '{"lift":"squat"}')] }),
    });
    const { client } = build(provider, { tools: { maxIterations: 3 } });

    const result = await client.generate({ ...ask, tools: [tool] });

    expect(provider.calls).toHaveLength(3);
    expect(result.iterations).toBe(3);
    const degradation = result.degradations.find(d => d.feature === 'toolUse');
    expect(degradation).toBeDefined();
    expect(degradation!.reason).toMatch(/maxToolIterations/);
    // `degradations.length === 0` must keep meaning "everything was honored".
    expect(result.degradations.length).toBeGreaterThan(0);
  });

  test('a per-request cap below the config ceiling is honored', async () => {
    const { tool } = recordingTool();
    const provider = createFakeAiProvider({
      capabilities: TOOL_CAPABLE,
      handler: () => ({ toolCalls: [call('get_lift_trend', '{"lift":"squat"}')] }),
    });
    const { client } = build(provider, { tools: { maxIterations: 8 } });

    await client.generate({ ...ask, tools: [tool], maxToolIterations: 2 });
    expect(provider.calls).toHaveLength(2);
  });

  test('asking for MORE than the config ceiling throws before anything is spent', async () => {
    // Clamping would be a shortfall discovered after the money is gone, and a
    // deployment ceiling a request can talk its way past is not a ceiling.
    const { tool } = recordingTool();
    const provider = createFakeAiProvider({ capabilities: TOOL_CAPABLE, responses: ['ok'] });
    const { client } = build(provider, { tools: { maxIterations: 4 } });

    await expect(client.generate({ ...ask, tools: [tool], maxToolIterations: 40 })).rejects.toThrow(
      AiConfigError,
    );
    expect(provider.calls).toHaveLength(0);
  });
});

describe('refusing rather than doing something else', () => {
  test('a provider declaring toolUse: false THROWS when handed tools', async () => {
    // The images rule. Sending the request without the tools would look
    // completely successful while changing what was asked — the model would
    // answer from memory a question it was supposed to look up.
    const { tool } = recordingTool();
    const provider = createFakeAiProvider({ responses: ['ok'] });
    const { client } = build(provider);

    await expect(client.generate({ ...ask, tools: [tool] })).rejects.toThrow(
      AiUnsupportedFeatureError,
    );
    expect(provider.calls).toHaveLength(0);
  });

  test('two tools sharing a name throw rather than silently shadowing', async () => {
    const { tool } = recordingTool();
    const provider = createFakeAiProvider({ capabilities: TOOL_CAPABLE, responses: ['ok'] });
    const { client } = build(provider);

    await expect(client.generate({ ...ask, tools: [tool, tool] })).rejects.toThrow(AiConfigError);
    expect(provider.calls).toHaveLength(0);
  });

  test('generateStructured refuses tools and says what to do instead', async () => {
    const { tool } = recordingTool();
    const provider = createFakeAiProvider({
      capabilities: { ...TOOL_CAPABLE, structuredOutput: 'native' },
      responses: [{ text: '{"ok":true}' }],
    });
    const { client } = build(provider);

    await expect(
      client.generateStructured({ ...ask, schema: z.object({ ok: z.boolean() }), tools: [tool] }),
    ).rejects.toThrow(/generate\(\) or stream\(\)/);
    expect(provider.calls).toHaveLength(0);
  });
});

describe('usage across iterations', () => {
  test('adds up, and stays disjoint within each iteration', async () => {
    const { tool } = recordingTool();
    const provider = createFakeAiProvider({
      capabilities: { ...TOOL_CAPABLE, costAccounting: true, usageAccounting: 'full' },
      responses: [
        {
          toolCalls: [call('get_lift_trend', '{"lift":"squat"}')],
          usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
        },
        {
          text: 'done',
          usage: { inputTokens: 20, outputTokens: 30, cacheReadTokens: 90, cacheWriteTokens: 0 },
        },
      ],
    });
    const { client } = build(provider, {
      providers: {
        test: { provider, pricing: { 'fake-model-1': { inputPerMTok: 1, outputPerMTok: 2 } } },
      },
    });

    const result = await client.generate({ ...ask, tools: [tool] });

    expect(result.usage.inputTokens).toBe(120);
    expect(result.usage.outputTokens).toBe(40);
    expect(result.usage.cacheReadTokens).toBe(90);
    // Iteration 1: (100*1 + 10*2)/1e6. Iteration 2: (20*1 + 30*2 + 90*1)/1e6.
    expect(result.usage.costUsd).toBeCloseTo((120 + 170) / 1_000_000, 12);
  });

  test('ONE unpriced iteration makes the whole turn cost null, not a partial sum', async () => {
    // `costUsd: null` means UNKNOWN. A total that silently omits a component is
    // a fabricated number that reads as authoritative.
    const { tool } = recordingTool();
    let callIndex = 0;
    const provider = createFakeAiProvider({
      capabilities: { ...TOOL_CAPABLE, costAccounting: true, usageAccounting: 'full' },
      handler: () =>
        callIndex++ === 0
          ? { toolCalls: [call('get_lift_trend', '{"lift":"squat"}')] }
          : { text: 'done' },
    });
    // Priced for the default model only; the second iteration is billed against
    // a model the table does not know.
    const { client } = build(provider, {
      providers: { test: { provider, pricing: {} } },
    });

    const result = await client.generate({ ...ask, tools: [tool] });
    expect(result.usage.costUsd).toBeNull();
  });

  test('writes ONE ledger row per provider call, not one per turn', async () => {
    // The per-call ledger is the only place cross-iteration behavior — cache
    // hits above all — is visible. A per-turn row averages it away.
    const { tool } = recordingTool();
    const provider = createFakeAiProvider({
      capabilities: { ...TOOL_CAPABLE, costAccounting: true, usageAccounting: 'full' },
      responses: [{ toolCalls: [call('get_lift_trend', '{"lift":"squat"}')] }, { text: 'done' }],
    });
    const { client, usage } = build(provider);

    await client.generate({ ...ask, tools: [tool] });

    const summary = await usage.summary();
    expect(summary.calls).toBe(2);
  });
});

describe('caches', () => {
  test('the response cache is bypassed when tools are present', async () => {
    // The cache key cannot see what a tool returned, so two identical prompts a
    // day apart would share an answer built from stale facts.
    const { tool } = recordingTool();
    let index = 0;
    const provider = createFakeAiProvider({
      capabilities: TOOL_CAPABLE,
      handler: () => `answer ${index++}`,
    });
    const { client } = build(provider, { responseCache: { enabled: true } });

    const first = await client.generate({ ...ask, tools: [tool], cache: { ttlSeconds: 60 } });
    const second = await client.generate({ ...ask, tools: [tool], cache: { ttlSeconds: 60 } });

    expect(second.value).not.toBe(first.value);
    expect(second.cached).toBe('none');
    expect(provider.calls).toHaveLength(2);
  });

  test('in-flight coalescing is bypassed too', async () => {
    // Collapsing five concurrent requests into one loop hands four callers a
    // trace of tool calls their request never made — and, with write tools, four
    // writes that never happened.
    const { tool } = recordingTool();
    const provider = createFakeAiProvider({ capabilities: TOOL_CAPABLE, responses: ['ok'] });
    const { client } = build(provider);

    await Promise.all([
      client.generate({ ...ask, tools: [tool] }),
      client.generate({ ...ask, tools: [tool] }),
      client.generate({ ...ask, tools: [tool] }),
    ]);

    expect(provider.calls).toHaveLength(3);
  });
});

describe('abort', () => {
  test('stops the loop between iterations', async () => {
    const controller = new AbortController();
    const aborting: AiTool<{ lift: string }> = {
      name: 'get_lift_trend',
      description: 'x',
      schema: z.object({ lift: z.string() }),
      async execute(args) {
        controller.abort();
        return args.lift;
      },
    };
    const provider = createFakeAiProvider({
      capabilities: TOOL_CAPABLE,
      handler: () => ({ toolCalls: [call('get_lift_trend', '{"lift":"squat"}')] }),
    });
    const { client } = build(provider);

    await expect(
      client.generate({ ...ask, tools: [aborting], signal: controller.signal }),
    ).rejects.toThrow();
    // One provider call made, the tool ran, and the loop stopped rather than
    // going round again on a request the caller has abandoned.
    expect(provider.calls).toHaveLength(1);
  });

  test('an already-aborted signal makes no provider call at all', async () => {
    const { tool } = recordingTool();
    const provider = createFakeAiProvider({ capabilities: TOOL_CAPABLE, responses: ['ok'] });
    const { client } = build(provider);

    await expect(
      client.generate({ ...ask, tools: [tool], signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(provider.calls).toHaveLength(0);
  });
});

describe('streaming', () => {
  test('text deltas concatenate to finalResult().value with tool events interleaved', async () => {
    const { tool } = recordingTool();
    const { client } = build(
      createFakeAiProvider({
        capabilities: TOOL_CAPABLE,
        responses: [
          { text: 'Let me check. ', toolCalls: [call('get_lift_trend', '{"lift":"squat"}')] },
          { text: "You're up 12kg." },
        ],
      }),
    );

    const stream = client.stream({ ...ask, tools: [tool] });
    const events: AiStreamEvent[] = [];
    let text = '';
    for await (const event of stream) {
      events.push(event);
      if (event.type === 'text') text += event.delta;
    }
    const final = await stream.finalResult();

    // The invariant, across the WHOLE turn rather than one provider call.
    expect(text).toBe(final.value);
    expect(final.iterations).toBe(2);

    const kinds = events.map(e => e.type);
    expect(kinds).toContain('tool_call_delta');
    expect(kinds).toContain('tool_call');
    expect(kinds).toContain('tool_result');
    expect(kinds.filter(k => k === 'done')).toHaveLength(1);
    expect(kinds.at(-1)).toBe('done');

    // The raw delta names the call before the validated event exists — that is
    // its entire purpose.
    expect(kinds.indexOf('tool_call_delta')).toBeLessThan(kinds.indexOf('tool_call'));
    expect(kinds.indexOf('tool_call')).toBeLessThan(kinds.indexOf('tool_result'));
  });

  test('the validated tool_call event carries parsed args, the delta carries raw text', async () => {
    const { tool } = recordingTool();
    const { client } = build(
      createFakeAiProvider({
        capabilities: TOOL_CAPABLE,
        responses: [{ toolCalls: [call('get_lift_trend', '{"lift":"squat"}')] }, { text: 'done' }],
      }),
    );

    let raw = '';
    let validated: unknown;
    for await (const event of client.stream({ ...ask, tools: [tool] })) {
      if (event.type === 'tool_call_delta') raw += event.argumentsDelta;
      if (event.type === 'tool_call') validated = event.args;
    }

    expect(raw).toBe('{"lift":"squat"}');
    expect(validated).toEqual({ lift: 'squat' });
  });

  test('a failed call still produces a trace: tool_call then tool_result ok:false', async () => {
    const { tool } = recordingTool();
    const { client } = build(
      createFakeAiProvider({
        capabilities: TOOL_CAPABLE,
        responses: [{ toolCalls: [call('get_lift_trend', '{"lift":42}')] }, { text: 'sorry' }],
      }),
    );

    const seen: AiStreamEvent[] = [];
    for await (const event of client.stream({ ...ask, tools: [tool] })) seen.push(event);

    const resultEvent = seen.find(e => e.type === 'tool_result');
    expect(resultEvent).toMatchObject({ name: 'get_lift_trend', ok: false });
    // The call is still reported: a trace is a record of what the model DID,
    // not only of what succeeded.
    expect(seen.some(e => e.type === 'tool_call')).toBe(true);
  });

  test('a non-streaming provider still runs the loop, and says it is not incremental', async () => {
    const { tool } = recordingTool();
    const { client } = build(
      createFakeAiProvider({
        capabilities: { toolUse: true },
        responses: [
          { text: 'checking ', toolCalls: [call('get_lift_trend', '{"lift":"squat"}')] },
          { text: 'up 12kg' },
        ],
      }),
    );

    const stream = client.stream({ ...ask, tools: [tool] });
    let text = '';
    for await (const event of stream) if (event.type === 'text') text += event.delta;
    const final = await stream.finalResult();

    expect(text).toBe('checking up 12kg');
    expect(final.value).toBe('checking up 12kg');
    expect(final.iterations).toBe(2);
    expect(final.degradations.map(d => d.feature)).toContain('streaming');
  });

  test('a failure reaches a caller who only iterates', async () => {
    const exploding: AiTool<Record<string, never>> = {
      name: 'boom',
      description: 'x',
      schema: z.object({}),
      execute: () => Promise.resolve(null),
    };
    const { client } = build(
      createFakeAiProvider({
        capabilities: TOOL_CAPABLE,
        responses: [{ error: new Error('provider is down') }],
      }),
    );

    const iterate = async (): Promise<void> => {
      for await (const _ of client.stream({ ...ask, tools: [exploding] })) {
        // A caller who never calls finalResult() must still see the failure,
        // rather than hanging on a turn that already died.
      }
    };
    await expect(iterate()).rejects.toThrow('provider is down');
  });
});

describe('content-part accounting', () => {
  test('a tool result is SIZED for the spend estimate but is not TEXT', async () => {
    const big = { notes: 'x'.repeat(5000) };
    const parts = [
      { type: 'text' as const, text: 'hello' },
      { type: 'tool_call' as const, id: 'c1', name: 'f', argumentsJson: '{"a":1}' },
      { type: 'tool_result' as const, id: 'c1', name: 'f', result: big },
    ];

    // Sized: the message list GROWS by one of these every iteration, and an
    // estimator blind to them under-counts precisely the loop the pre-flight
    // spend guard exists to catch.
    expect(messageContentUnits(parts)).toBeGreaterThan(5000);

    // But not text: `messageContentText` feeds the moderation extractor, and a
    // moderator handed a page of tool JSON is judging the wrong thing.
    expect(messageContentText(parts)).toBe('hello');
  });
});

describe('backwards compatibility', () => {
  test('a call with no tools reports iterations: 1 and no tool calls', async () => {
    const { client } = build(createFakeAiProvider({ responses: ['plain'] }));

    const result = await client.generate(ask);
    expect(result.iterations).toBe(1);
    expect(result.toolCalls).toEqual([]);
  });
});
