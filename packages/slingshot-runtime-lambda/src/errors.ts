/**
 * Thrown when a manifest-driven Lambda binding cannot be resolved to a valid
 * Slingshot handler. The message is intentionally verbose: it carries the
 * manifest binding (export) name, the manifest handler reference being looked
 * up, the resolved file path on disk (when available), the expected export
 * name, the list of exports the file actually produced (when applicable), and
 * the original error message — everything an operator needs to spot a typo or
 * a wrong path without reaching for a debugger.
 */
export class HandlerResolutionError extends Error {
  /** The manifest export key (e.g. `processOrderApi`). */
  readonly exportName: string;
  /** The handler reference declared in the manifest (e.g. `processOrder`). */
  readonly handlerRef: string;
  /** The resolved file path on disk, when known. */
  readonly handlersPath?: string;
  /** The list of exports the loaded file produced, when known. */
  readonly availableExports?: readonly string[];

  constructor(
    message: string,
    details: {
      exportName: string;
      handlerRef: string;
      handlersPath?: string;
      availableExports?: readonly string[];
      cause?: unknown;
    },
  ) {
    super(message, details.cause !== undefined ? { cause: details.cause } : undefined);
    this.name = 'HandlerResolutionError';
    this.exportName = details.exportName;
    this.handlerRef = details.handlerRef;
    if (details.handlersPath !== undefined) this.handlersPath = details.handlersPath;
    if (details.availableExports !== undefined) this.availableExports = details.availableExports;
  }
}
