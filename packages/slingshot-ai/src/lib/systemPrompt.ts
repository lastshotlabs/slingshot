/**
 * System-prompt rendering + the prompt-cache detectors.
 *
 * Prompt caching is a prefix match: any byte change anywhere in the cached
 * prefix invalidates everything after it, and the failure is SILENT — you just
 * quietly pay full price forever. Everything in this file exists to turn that
 * silent failure into a loud one.
 */
import type { AiLogger, ProviderCapabilities, RenderedSystemBlock } from '../provider/types';
import type { AiDegradation, CachedSystem, SystemPrompt } from '../types';

/** Rough token estimate when the provider can't count for us. Chars/4 is close enough. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** FNV-1a — small, fast, and we only need change detection, not cryptography. */
function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

function toCachedSystem(system: SystemPrompt | undefined): CachedSystem {
  if (!system) return { stable: [] };
  if (typeof system === 'string') {
    // A bare string is entirely volatile — we have no idea which parts are
    // stable, so we must not claim any of it is cacheable.
    return { stable: [], volatile: [{ id: 'system', text: system }] };
  }
  return system;
}

export interface RenderedSystem {
  readonly blocks: readonly RenderedSystemBlock[];
  readonly degradations: readonly AiDegradation[];
  readonly promptCacheKey: string;
  readonly breakpointEmitted: boolean;
  readonly stableTokens: number;
}

/**
 * Tracks per-segment hashes so we can name the segment that drifted, and
 * per-key cache-read counts so we can notice a breakpoint that never hits.
 *
 * Instance-scoped (one per client), so tests don't bleed into each other.
 */
export class PromptCacheMonitor {
  private readonly segmentHashes = new Map<string, Map<string, string>>();
  private readonly zeroHitStreak = new Map<string, number>();
  private readonly warnedZeroHit = new Set<string>();

  constructor(
    private readonly logger: AiLogger,
    private readonly devWarnings: boolean,
    private readonly zeroHitWarnAfter: number,
    private readonly onPrefixChanged?: (cacheKey: string, segmentId: string) => void,
  ) {}

  /**
   * Detector 2 — the silent invalidator.
   *
   * Catches the classic bug: a `matchId`, a `Date.now()`, a roster interpolated
   * into what the app *believes* is a stable segment. Without this you get no
   * error, no warning, and a 10x bill.
   */
  checkDrift(cacheKey: string, stable: readonly { id: string; text: string }[]): void {
    const previous = this.segmentHashes.get(cacheKey);
    const current = new Map<string, string>();
    for (const segment of stable) current.set(segment.id, hashText(segment.text));

    if (previous) {
      for (const [id, hash] of current) {
        const before = previous.get(id);
        if (before !== undefined && before !== hash) {
          this.onPrefixChanged?.(cacheKey, id);
          if (this.devWarnings) {
            this.logger.warn(
              `prompt cache prefix changed for key '${cacheKey}' — segment '${id}' differs from ` +
                `the previous call. Every byte of the stable prefix must be identical or the cache ` +
                `is invalidated. Move per-call content into \`volatile\`.`,
              { cacheKey, segmentId: id },
            );
          }
        }
      }
    }
    this.segmentHashes.set(cacheKey, current);
  }

  /** Detector 3 — a breakpoint that has never once been read from. */
  recordCacheRead(cacheKey: string, cacheReadTokens: number, breakpointEmitted: boolean): void {
    if (!breakpointEmitted || !this.devWarnings) return;
    if (cacheReadTokens > 0) {
      this.zeroHitStreak.set(cacheKey, 0);
      return;
    }
    const streak = (this.zeroHitStreak.get(cacheKey) ?? 0) + 1;
    this.zeroHitStreak.set(cacheKey, streak);
    if (streak >= this.zeroHitWarnAfter && !this.warnedZeroHit.has(cacheKey)) {
      this.warnedZeroHit.add(cacheKey);
      this.logger.warn(
        `prompt cache for key '${cacheKey}' has been written ${streak} times without a single ` +
          `cache read. Something is invalidating the prefix on every call.`,
        { cacheKey, streak },
      );
    }
  }
}

/**
 * Render a system prompt into provider blocks, placing the cache breakpoint
 * correctly (or refusing to place one, which is often the right answer).
 */
export function renderSystem(options: {
  system: SystemPrompt | undefined;
  capabilities: ProviderCapabilities;
  promptCacheEnabled: boolean;
  promptCacheKey?: string;
  monitor?: PromptCacheMonitor;
  countTokens?: (text: string) => number;
}): RenderedSystem {
  const { system, capabilities, promptCacheEnabled, monitor } = options;
  const cached = toCachedSystem(system);
  const degradations: AiDegradation[] = [];
  const count = options.countTokens ?? estimateTokens;

  const stableText = cached.stable.map(s => s.text).join('\n\n');
  const stableTokens = stableText ? count(stableText) : 0;
  const promptCacheKey =
    options.promptCacheKey ??
    (cached.stable.length > 0 ? hashText(cached.stable.map(s => s.id).join('|')) : 'none');

  if (cached.stable.length > 0 && monitor) {
    monitor.checkDrift(promptCacheKey, cached.stable);
  }

  const wantsCaching = promptCacheEnabled && cached.stable.length > 0;
  let breakpointEmitted = false;

  if (wantsCaching) {
    if (capabilities.promptCaching === 'none') {
      degradations.push({
        feature: 'promptCaching',
        requested: 'explicit',
        applied: 'none',
        reason: 'the selected provider does not support prompt caching',
      });
    } else if (capabilities.promptCaching === 'explicit') {
      const minimum = capabilities.promptCacheMinTokens ?? 0;
      if (stableTokens < minimum) {
        // Detector 1 — the minimum-length guard. This is the highest-value
        // line in the file: a below-minimum breakpoint is ACCEPTED by the API
        // and then does nothing at all. Emitting one would be worse than
        // useless, because it looks like caching is configured.
        degradations.push({
          feature: 'promptCaching',
          requested: 'explicit',
          applied: 'none',
          reason:
            `stable prefix is ~${stableTokens} tokens, below the provider minimum of ${minimum} — ` +
            `a breakpoint here would be accepted and then silently not cache`,
        });
      } else {
        breakpointEmitted = true;
      }
    }
    // 'automatic' (e.g. OpenAI): the provider caches on its own. Nothing to
    // emit, nothing to degrade.
  }

  const blocks: RenderedSystemBlock[] = [];
  cached.stable.forEach((segment, index) => {
    const isLastStable = index === cached.stable.length - 1;
    blocks.push({ text: segment.text, cache: breakpointEmitted && isLastStable });
  });
  for (const segment of cached.volatile ?? []) {
    // Volatile content is ALWAYS after the breakpoint. That invariant is the
    // whole point of the CachedSystem type.
    blocks.push({ text: segment.text, cache: false });
  }

  return { blocks, degradations, promptCacheKey, breakpointEmitted, stableTokens };
}
