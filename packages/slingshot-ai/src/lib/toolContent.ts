/**
 * Rendering a tool result onto a wire.
 *
 * Every transport in this package sends a tool result as TEXT — Anthropic's
 * `tool_result.content`, OpenAI's `role: 'tool'` message body, Gemini's
 * `functionResponse.response`. So there is exactly one place that decides what
 * that text is, rather than three adapters each inventing a `JSON.stringify`
 * call and disagreeing about `undefined`.
 */
import type { AiToolResultPart } from '../provider/types';

/**
 * The tool's return value as the model will read it.
 *
 * A string is passed through — a tool that already produced prose should not
 * arrive quoted. Everything else is JSON. `undefined` becomes `"null"` rather
 * than the empty string, because `JSON.stringify(undefined)` is `undefined` and
 * an empty tool result reads to a model as "the tool returned nothing", which is
 * a different claim from "the tool returned no value".
 */
export function toolResultBody(result: unknown): string {
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result) ?? 'null';
  } catch {
    // A cyclic or unserializable value is a bug in the app's tool, but failing
    // the whole turn over it would lose the other tools' results too.
    return String(result);
  }
}

/**
 * The same, for a transport with NO error flag on its wire (OpenAI's `role:
 * 'tool'` message and Gemini's `functionResponse` both lack one).
 *
 * The prefix is not decoration: without it a failed tool is indistinguishable
 * from a successful one that happened to return an error-shaped object, and the
 * model would report the failure as a finding.
 */
export function toolResultWireText(part: AiToolResultPart): string {
  const body = toolResultBody(part.result);
  return part.isError ? `Error: ${body}` : body;
}
