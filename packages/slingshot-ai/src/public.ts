/**
 * Public contract for `slingshot-ai`.
 *
 * Three capabilities, not one — and not for symmetry:
 *
 *   - `AiClientCap` is generation. Nine methods, all about producing tokens.
 *   - `AiModerationCap` is safety verdicts. Independently useful: moderating
 *     player-typed content involves no generation, and a package that only
 *     needs safety shouldn't depend on a surface that can spend money. It is
 *     also the swap point for a non-LLM classifier.
 *   - `AiUsageCap` is a read-only projection over usage + spend. Different
 *     lifecycle, different consumer (admin/observability, never generation code).
 *
 * The split makes `capabilities.requires` honest: a consumer that declares
 * `[AiClientCap, AiModerationCap]` gets a boot-time error if the package isn't
 * installed, and says exactly what it uses.
 */
import { definePackageContract } from '@lastshotlabs/slingshot-core';
import type { AiClient, AiModerator, AiUsageReader } from './types';

/** Provider-owned package contract for `slingshot-ai`. */
export const Ai = definePackageContract('slingshot-ai');

/** Generation: `generate` / `generateStructured` / `stream` / background. */
export const AiClientCap = Ai.capability<AiClient>('client');

/** Content moderation verdicts. May be backed by a different provider than generation. */
export const AiModerationCap = Ai.capability<AiModerator>('moderation');

/** Usage, cost, and spend reads. */
export const AiUsageCap = Ai.capability<AiUsageReader>('usage');
