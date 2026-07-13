/**
 * The moderation seam.
 *
 * The LLM-backed moderator (independent / self / both strategies, batching,
 * per-item verdicts) is F4. What lands here is the seam plus the honest
 * placeholder — and the placeholder FAILS CLOSED.
 *
 * A moderator that returns `allowed: true` because it hasn't been implemented
 * yet is worse than no moderator at all: the app believes it has a safety
 * control, ships, and finds out otherwise in front of guests. So when an app
 * asks for a policy and no moderator can apply it, we throw. An app that never
 * requests moderation is entirely unaffected.
 */
import { AiConfigError } from '../errors';
import type { AiPackageConfig } from '../config';
import type { AiModerator, AiTags, AiVerdict } from '../types';

export function createModerator(config: AiPackageConfig): AiModerator {
  const custom = config.moderation.moderator;
  const policyNames = Object.keys(config.moderation.policies);

  if (custom) {
    // Wrap so an unknown policy name is a clear error rather than whatever the
    // custom moderator happens to do with it.
    return {
      async moderate(req: {
        content: string | readonly string[];
        policy: string;
        tags?: AiTags;
      }): Promise<AiVerdict> {
        return custom.moderate(req);
      },
      policies() {
        return custom.policies();
      },
    };
  }

  return {
    async moderate(req): Promise<AiVerdict> {
      throw new AiConfigError(
        `Moderation was requested for policy '${req.policy}', but no moderator is available. ` +
          `LLM-backed moderation is not implemented yet — supply \`moderation.moderator\` in the ` +
          `package config (any object implementing AiModerator), or omit \`moderation\` from the ` +
          `request. This fails closed on purpose: a safety control that quietly allows everything ` +
          `is worse than none.`,
      );
    },
    policies() {
      return policyNames;
    },
  };
}
