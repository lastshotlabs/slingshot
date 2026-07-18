/**
 * The fake provider must pass the same contract every real adapter passes.
 *
 * This is not ceremony. The fake is what every app's tests run against, so if it
 * were allowed to behave in ways a real provider cannot, every app in the fleet
 * would be testing against a fiction. Running it through the shared suite is how
 * we keep the fake honest.
 *
 * F3 adds `runProviderConformanceSuite('anthropic', ...)` and
 * `runProviderConformanceSuite('openai-compatible', ...)` against recorded
 * fixtures. Same suite, no edits.
 */
import { createFakeAiProvider, runProviderConformanceSuite } from '../../src/testing';

runProviderConformanceSuite('fake (conservative defaults)', () => createFakeAiProvider());

runProviderConformanceSuite('fake (fully capable)', () =>
  createFakeAiProvider({
    responses: ['hello from the fake provider'],
    capabilities: {
      structuredOutput: 'native',
      promptCaching: 'explicit',
      promptCacheMinTokens: 1024,
      streaming: true,
      thinking: 'adaptive',
      effort: true,
      usageAccounting: 'full',
      costAccounting: true,
      refusalSignal: true,
      imageInput: true,
      toolUse: true,
      maxOutputTokens: 8192,
    },
  }),
);
