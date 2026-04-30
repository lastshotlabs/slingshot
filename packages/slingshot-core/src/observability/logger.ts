/**
 * Structured logger contract used by prod-track packages.
 *
 * The interface is deliberately small: four severity methods plus `child()`
 * for fields that should appear on every log line in a sub-component (request
 * id, plugin name, queue id, etc.). Implementations must never throw — log
 * sinks that crash the caller are worse than silent loss.
 *
 * `createConsoleLogger` is the default — one JSON line per call written to the
 * underlying console method matching the level. `noopLogger` is the test
 * default for code paths that need a logger handle but no output.
 */

/** Severity ordering used by {@link createConsoleLogger} for level filtering. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Free-form structured fields attached to a log line. */
export interface LogFields {
  [key: string]: unknown;
}

/**
 * Structured logger handle. Implementations must not throw from any method.
 */
export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Return a new logger that merges `fields` into every emitted record. */
  child(fields: LogFields): Logger;
}

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * Create a console-backed JSON logger. Each call emits a single JSON line via
 * the console method matching the level (`console.debug`, `console.info`,
 * `console.warn`, `console.error`). Lines below the configured `level` are
 * suppressed.
 */
export function createConsoleLogger(opts?: { level?: LogLevel; base?: LogFields }): Logger {
  const minRank = LEVEL_RANK[opts?.level ?? 'info'];
  const base = opts?.base;
  return makeLogger(minRank, base);
}

function makeLogger(minRank: number, base: LogFields | undefined): Logger {
  function emit(level: LogLevel, msg: string, fields: LogFields | undefined): void {
    if (LEVEL_RANK[level] < minRank) return;
    const record: LogFields = {
      level,
      timestamp: new Date().toISOString(),
      msg,
      ...(base ?? {}),
      ...(fields ?? {}),
    };
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      // Circular or unserializable fields — emit degraded record with error marker
      line = JSON.stringify({ level, timestamp: record.timestamp, msg, error: 'unserializable' });
    }
    const sink =
      level === 'error'
        ? console.error
        : level === 'warn'
          ? console.warn
          : level === 'debug'
            ? console.debug
            : console.info;
    try {
      sink(line);
    } catch {
      // logging must never throw
    }
  }

  return {
    debug(msg, fields) {
      emit('debug', msg, fields);
    },
    info(msg, fields) {
      emit('info', msg, fields);
    },
    warn(msg, fields) {
      emit('warn', msg, fields);
    },
    error(msg, fields) {
      emit('error', msg, fields);
    },
    child(fields) {
      return makeLogger(minRank, { ...(base ?? {}), ...fields });
    },
  };
}

/** Logger that drops every record. Safe default for tests and benchmarks. */
export const noopLogger: Logger = Object.freeze({
  debug(): void {
    /* no-op */
  },
  info(): void {
    /* no-op */
  },
  warn(): void {
    /* no-op */
  },
  error(): void {
    /* no-op */
  },
  child(): Logger {
    return noopLogger;
  },
});
