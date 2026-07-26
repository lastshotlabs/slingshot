/**
 * Tool resolution and execution — the half of the tool loop that is pure.
 *
 * The orchestrator (`client.ts`) owns the loop itself, because the loop is spend
 * guard, reservation, usage and degradation policy. What lives here is the part
 * with no policy in it: turning app-declared tools into the shape a transport
 * needs, and turning one provider tool call into one result.
 *
 * The load-bearing rule in this file is invariant 1: **arguments are validated
 * here, never trusted from the provider.** `ProviderResult.structured` is
 * advisory for exactly the same reason — a vendor claiming `strict: true` on a
 * function schema is making the identical claim we already refuse to take on
 * trust for a response schema, and one of them is about to be handed to an app's
 * database write.
 */
import { AiConfigError } from '../errors';
import type { AiLogger, NormalizedTool, ProviderToolCall } from '../provider/types';
import type { AiTool, AiToolCallRecord, AiToolResultPart } from '../types';
import { describeError, toJsonSchema } from './structured';

/** App tools, prepared once per request. */
export interface ResolvedTools {
  /** What goes on the wire. */
  readonly normalized: readonly NormalizedTool[];
  readonly byName: ReadonlyMap<string, AiTool>;
  /** For the "unknown tool" message — a model can only fix what it can see. */
  readonly names: readonly string[];
}

/**
 * Sanitize every tool's schema once, and refuse ambiguity.
 *
 * Duplicate names throw rather than last-one-wins: with two tools under one name
 * exactly one of them is unreachable, and which one is an implementation detail
 * of `Map`. That is a coin flip in the app's behavior, discovered in production.
 */
export function resolveTools(
  tools: readonly AiTool[],
  options: { logger?: AiLogger; strict: boolean },
): ResolvedTools {
  const byName = new Map<string, AiTool>();
  const normalized: NormalizedTool[] = [];

  for (const tool of tools) {
    if (byName.has(tool.name)) {
      throw new AiConfigError(
        `Two tools are declared with the name '${tool.name}'. Exactly one of them would ever ` +
          `be reachable, and which one is an implementation detail — rename one.`,
      );
    }
    byName.set(tool.name, tool);
    normalized.push({
      name: tool.name,
      description: tool.description,
      jsonSchema: toJsonSchema(tool.schema, {
        logger: options.logger,
        strict: options.strict,
        name: tool.name,
      }),
    });
  }

  return { normalized, byName, names: [...byName.keys()] };
}

/** One executed call: what the model gets back, and what the app sees. */
export interface ToolExecution {
  readonly record: AiToolCallRecord;
  readonly part: AiToolResultPart;
}

function failure(
  call: ProviderToolCall,
  reason: string,
  args: unknown,
  startedAt: number,
): ToolExecution {
  return {
    record: {
      id: call.id,
      name: call.name,
      args,
      ok: false,
      durationMs: Date.now() - startedAt,
    },
    part: { type: 'tool_result', id: call.id, name: call.name, result: reason, isError: true },
  };
}

/**
 * Run one tool call, or explain to the model why it could not be run.
 *
 * **This function never rejects.** All four failure modes — unknown tool,
 * unparseable arguments, schema violation, a throwing `execute` — become an
 * `isError` tool result the model reads on the next iteration and can correct.
 * None of them ends the turn, and none of them surfaces as an exception at the
 * app:
 *
 *   - An unknown tool name is the model hallucinating a capability. The only
 *     place it can be corrected is the conversation, so that is where the
 *     correction goes — naming the tools that do exist.
 *   - A parse or validation failure is the same class as a structured-output
 *     failure, and gets the same treatment the repair loop already gives: show
 *     the model its own output and the validation errors.
 *   - A throwing tool is an app-side failure the model may well be able to route
 *     around ("that lift has no data — try another"). Killing the turn would
 *     turn a recoverable gap into a failed request.
 *
 * `execute` is deliberately never retried. Retry policy for a side-effecting app
 * function is the app's business; this package's retry layer covers the provider
 * call only, and silently re-running a write tool is not a behavior a framework
 * gets to choose on an app's behalf.
 */
export async function executeToolCall(
  call: ProviderToolCall,
  tools: ResolvedTools,
  ctx: { signal?: AbortSignal; iteration: number },
): Promise<ToolExecution> {
  const startedAt = Date.now();

  const tool = tools.byName.get(call.name);
  if (!tool) {
    return failure(
      call,
      `Unknown tool '${call.name}'. Available tools: ${tools.names.join(', ') || '(none)'}.`,
      null,
      startedAt,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(call.argumentsJson) as unknown;
  } catch (error) {
    return failure(
      call,
      `The arguments for '${call.name}' were not valid JSON: ${(error as Error).message}. ` +
        `Call it again with a valid JSON object.`,
      null,
      startedAt,
    );
  }

  // THE validation point. Never `parsed` from the provider, never skipped
  // because the endpoint claims strict function schemas.
  const validated = tool.schema.safeParse(raw);
  if (!validated.success) {
    return failure(
      call,
      `The arguments for '${call.name}' did not match its schema:\n${describeError(validated.error)}`,
      raw,
      startedAt,
    );
  }

  const args: unknown = validated.data;
  try {
    const result = await tool.execute(validated.data, {
      signal: ctx.signal,
      iteration: ctx.iteration,
      toolCallId: call.id,
    });
    return {
      record: { id: call.id, name: call.name, args, ok: true, durationMs: Date.now() - startedAt },
      part: { type: 'tool_result', id: call.id, name: call.name, result },
    };
  } catch (error) {
    return failure(
      call,
      `The tool '${call.name}' failed: ${error instanceof Error ? error.message : String(error)}`,
      args,
      startedAt,
    );
  }
}
