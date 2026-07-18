/**
 * Registers the built-in adapters, by import side-effect.
 *
 * This module exists so the registration happens in exactly one place, and so
 * that importing an ADAPTER never means importing its SDK. Both adapter modules
 * are safe to import eagerly:
 *
 *   - `openaiCompatible` has zero dependencies (plain `fetch`).
 *   - `anthropic` imports `@anthropic-ai/sdk` lazily, inside its async factory —
 *     so an app that only talks to a local model is never forced to install it.
 *
 * `plugin.ts` imports this, which means every consumer of `createAiPackage()`
 * gets the built-ins without doing anything.
 */
import './anthropic';
import './gemini';
import './openaiCompatible';

export { createAnthropicProvider } from './anthropic';
export { createGeminiProvider } from './gemini';
export {
  createDeepSeekProvider,
  createGrokProvider,
  createOpenAiCompatibleProvider,
  createOpenAiProvider,
} from './openaiCompatible';
