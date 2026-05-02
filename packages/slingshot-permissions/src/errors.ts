/** Errors thrown by the permissions plugin. */

/**
 * Base error class for all permissions-related errors.
 * Carries a machine-readable `code` for programmatic discrimination at catch sites.
 */
export class PermissionsError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: Error }) {
    super(message, options);
    this.name = 'PermissionsError';
    this.code = code;
  }
}

/**
 * Thrown when permissions plugin configuration is invalid or unsupported.
 */
export class PermissionsConfigError extends PermissionsError {
  constructor(message: string) {
    super('PERMISSIONS_CONFIG_ERROR', message);
    this.name = 'PermissionsConfigError';
  }
}

/**
 * Thrown when a permissions adapter cannot be resolved or fails an adapter operation.
 */
export class PermissionsAdapterError extends PermissionsError {
  readonly adapter: string;

  constructor(adapter: string, message: string, options?: { cause?: Error }) {
    super('PERMISSIONS_ADAPTER_ERROR', message, options);
    this.name = 'PermissionsAdapterError';
    this.adapter = adapter;
  }
}

export { PermissionQueryTimeoutError } from './lib/evaluator';
