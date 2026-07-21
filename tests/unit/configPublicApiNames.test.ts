import { expect, test } from 'bun:test';
import type { AiPackageConfig, AiPluginConfig } from '../../packages/slingshot-ai/src';
import type {
  DeepLinksConfig,
  DeepLinksPluginConfig,
} from '../../packages/slingshot-deep-links/src';
import type { EmojiPackageConfig, EmojiPluginConfig } from '../../packages/slingshot-emoji/src';
import {
  GameEnginePluginConfigSchema,
  gameEnginePluginConfigSchema,
} from '../../packages/slingshot-game-engine/src';
import type { OAuthPluginConfig, OAuthPluginOptions } from '../../packages/slingshot-oauth/src';
import type {
  OrchestrationPluginConfig,
  OrchestrationPluginOptions,
} from '../../packages/slingshot-orchestration/src';
import {
  PollsPluginConfigSchema,
  pollsPluginConfigSchema,
} from '../../packages/slingshot-polls/src';
import type {
  WebhookPluginConfig,
  WebhooksPluginConfig,
} from '../../packages/slingshot-webhooks/src';

type Same<A, B> = [A, B] extends [B, A] ? true : false;

const aliasesAreCompatible: readonly true[] = [
  true satisfies Same<AiPluginConfig, AiPackageConfig>,
  true satisfies Same<EmojiPluginConfig, EmojiPackageConfig>,
  true satisfies Same<OAuthPluginConfig, OAuthPluginOptions>,
  true satisfies Same<OrchestrationPluginConfig, OrchestrationPluginOptions>,
  true satisfies Same<DeepLinksPluginConfig, DeepLinksConfig>,
  true satisfies Same<WebhooksPluginConfig, WebhookPluginConfig>,
];

test('canonical config API names preserve compatibility aliases', () => {
  expect(aliasesAreCompatible).toHaveLength(6);
  expect(pollsPluginConfigSchema).toBe(PollsPluginConfigSchema);
  expect(gameEnginePluginConfigSchema).toBe(GameEnginePluginConfigSchema);
});
