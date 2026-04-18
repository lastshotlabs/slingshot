import type { LogLevel, RequestLogEntry } from '@framework/middleware/requestLogger';

export interface LoggingConfig {
  /** Enable structured request logging. Default: true. When false, no logger is registered at all. */
  enabled?: boolean;
  /** Custom log handler. Default: `console.log(JSON.stringify(entry))`. */
  onLog?: (entry: RequestLogEntry) => void | Promise<void>;
  /** Minimum log level to emit. Entries below this level are dropped. */
  level?: LogLevel;
  /**
   * Paths to exclude from logging. Strings use **prefix matching**.
   * Default: `["/health", "/docs", "/openapi.json"]`.
   */
  excludePaths?: (string | RegExp)[];
  /** HTTP methods to exclude from logging (e.g. `["OPTIONS"]`). */
  excludeMethods?: string[];
}
