import { type Logger, createConsoleLogger } from '@lastshotlabs/slingshot-core';

export interface AuthLoggerConfig {
  verbose?: boolean;
  authTrace?: boolean;
  logger?: Logger;
}

export interface AuthLogger extends Logger {
  log: (...args: unknown[]) => void;
  authTrace: (...args: unknown[]) => void;
}

/** Shared structured fallback for standalone auth helpers. */
export const defaultAuthLogger = createConsoleLogger({
  base: { component: 'slingshot-auth' },
});

/**
 * Returns whether verbose (non-production) logging is enabled.
 *
 * Falls back to `LOGGING_VERBOSE` / non-production mode when no per-app config
 * is provided.
 */
function isVerbose(config?: AuthLoggerConfig): boolean {
  if (config?.verbose !== undefined) return config.verbose;
  const v = process.env.LOGGING_VERBOSE;
  return v !== undefined ? v === 'true' : process.env.NODE_ENV !== 'production';
}

/**
 * Returns whether auth trace logging is enabled.
 *
 * Falls back to `LOGGING_AUTH_TRACE === "true"` when no per-app config is
 * provided. Trace logs are also suppressed when verbose logging is disabled.
 */
function isAuthTrace(config?: AuthLoggerConfig): boolean {
  if (!isVerbose(config)) return false;
  if (config?.authTrace !== undefined) return config.authTrace;
  return process.env.LOGGING_AUTH_TRACE === 'true';
}

/**
 * Build an instance-scoped auth logger.
 *
 * Plugins pass the resolved framework logging policy here so auth logging
 * follows app config instead of relying solely on process-wide env vars.
 */
export function createAuthLogger(config: AuthLoggerConfig = {}): AuthLogger {
  const logger = config.logger ?? defaultAuthLogger;
  return {
    debug: logger.debug.bind(logger),
    info: logger.info.bind(logger),
    warn: logger.warn.bind(logger),
    error: logger.error.bind(logger),
    child: logger.child.bind(logger),
    log(...args: unknown[]) {
      if (isVerbose(config)) logger.debug('auth diagnostic', { args });
    },
    authTrace(...args: unknown[]) {
      if (isAuthTrace(config)) logger.debug('auth trace', { args });
    },
  };
}
