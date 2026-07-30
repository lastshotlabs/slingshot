/** Converts one governed event payload version into the next registered version. */
export interface EventVersionAdapter {
  readonly eventKey: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  adapt(payload: unknown): unknown;
}

/** Result of adapting a stored payload to the current governed event version. */
export interface EventVersionAdaptation {
  readonly payload: unknown;
  readonly storedVersion: number;
  readonly currentVersion: number;
  readonly adapted: boolean;
}

/** Immutable lookup contract for governed event-version adapters. */
export interface EventVersionRegistry {
  register(adapter: EventVersionAdapter): void;
  adapt(
    eventKey: string,
    storedVersion: number,
    currentVersion: number,
    payload: unknown,
  ): EventVersionAdaptation;
  freeze(): void;
  readonly frozen: boolean;
}

function assertVersion(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`[EventVersionRegistry] ${name} must be a positive integer.`);
  }
}

/**
 * Create an instance-scoped registry for explicit, ascending event payload migrations.
 *
 * Each adapter must advance exactly one version. This makes replay paths unique,
 * prevents accidental downgrade/cycles, and surfaces missing compatibility work
 * before an operator mutates durable outbox state.
 */
export function createEventVersionRegistry(): EventVersionRegistry {
  const adapters = new Map<string, Map<number, EventVersionAdapter>>();
  let frozen = false;

  return {
    register(adapter): void {
      if (frozen) {
        throw new Error('[EventVersionRegistry] Cannot register adapters after freeze().');
      }
      if (!adapter.eventKey.trim()) {
        throw new Error('[EventVersionRegistry] eventKey must be non-empty.');
      }
      assertVersion('fromVersion', adapter.fromVersion);
      assertVersion('toVersion', adapter.toVersion);
      if (adapter.toVersion !== adapter.fromVersion + 1) {
        throw new Error(
          `[EventVersionRegistry] Adapter "${adapter.eventKey}" must advance exactly one version.`,
        );
      }

      const versions = adapters.get(adapter.eventKey) ?? new Map<number, EventVersionAdapter>();
      if (versions.has(adapter.fromVersion)) {
        throw new Error(
          `[EventVersionRegistry] Adapter "${adapter.eventKey}" from version ${adapter.fromVersion} is already registered.`,
        );
      }
      versions.set(adapter.fromVersion, Object.freeze({ ...adapter }));
      adapters.set(adapter.eventKey, versions);
    },

    adapt(eventKey, storedVersion, currentVersion, payload): EventVersionAdaptation {
      assertVersion('storedVersion', storedVersion);
      assertVersion('currentVersion', currentVersion);
      if (storedVersion > currentVersion) {
        throw new Error(
          `[EventVersionRegistry] Stored "${eventKey}" version ${storedVersion} is newer than current version ${currentVersion}.`,
        );
      }

      let version = storedVersion;
      let value = payload;
      const versions = adapters.get(eventKey);
      while (version < currentVersion) {
        const adapter = versions?.get(version);
        if (!adapter) {
          throw new Error(
            `[EventVersionRegistry] Missing "${eventKey}" adapter from version ${version} to ${version + 1}.`,
          );
        }
        value = adapter.adapt(value);
        version = adapter.toVersion;
      }

      return {
        payload: value,
        storedVersion,
        currentVersion,
        adapted: storedVersion !== currentVersion,
      };
    },

    freeze(): void {
      frozen = true;
    },

    get frozen(): boolean {
      return frozen;
    },
  };
}
