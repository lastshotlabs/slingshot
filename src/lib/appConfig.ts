// Framework-only runtime configuration — context-aware access only.
// Auth-specific config (primary field, MFA, sessions, JWT, etc.) lives in authConfig.ts.
//
// Phase 1 singleton elimination: all module-level mutable state removed.
// App name, roles, and default role are available on SlingshotContext.config.
import { getContext } from '@lastshotlabs/slingshot-core';

/** Deep-freeze an object and all nested objects. */
export function deepFreeze<T extends object>(obj: T): Readonly<T> {
  Object.freeze(obj);
  for (const value of Object.values(obj)) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Context-aware getters
// ---------------------------------------------------------------------------

/**
 * Context-aware app name getter. Returns the instance-scoped app name from
 * SlingshotContext. Throws if no SlingshotContext is attached to the app.
 */
export const getAppNameFromApp = (app: object): string => {
  const ctx = getContext(app);
  return ctx.config.appName;
};
