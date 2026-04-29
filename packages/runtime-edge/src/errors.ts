/** Errors thrown by the Edge runtime implementation. */

export class EdgeRuntimeError extends Error {
  constructor(message: string) {
    super(`[runtime-edge] ${message}`);
    this.name = 'EdgeRuntimeError';
  }
}

/** Raised when code requests a runtime feature that edge isolates do not support. */
export class EdgeUnsupportedError extends EdgeRuntimeError {
  constructor(feature: string, detail?: string) {
    super(`${feature} is not available in the Edge runtime${detail ? `. ${detail}` : ''}`);
    this.name = 'EdgeUnsupportedError';
  }
}

/** Raised when the edge runtime cannot read a configured static file. */
export class EdgeFileReadError extends EdgeRuntimeError {
  readonly filePath: string;

  constructor(filePath: string, reason: string) {
    super(`file read error for "${filePath}": ${reason}`);
    this.name = 'EdgeFileReadError';
    this.filePath = filePath;
  }
}

/** Raised when an edge runtime file read exceeds the configured byte limit. */
export class EdgeFileSizeExceededError extends EdgeRuntimeError {
  readonly filePath: string;
  readonly maxBytes: number;
  readonly actualBytes: number;

  constructor(filePath: string, maxBytes: number, actualBytes: number) {
    super(
      `readFile('${filePath}') returned ${actualBytes} bytes; ` +
        `exceeds maxFileBytes=${maxBytes}. Stream large assets at the platform level ` +
        `or raise maxFileBytes after confirming isolate headroom.`,
    );
    this.name = 'EdgeFileSizeExceededError';
    this.filePath = filePath;
    this.maxBytes = maxBytes;
    this.actualBytes = actualBytes;
  }
}

/** Raised when edge password hashing and verification hooks are configured inconsistently. */
export class EdgePasswordConfigError extends EdgeRuntimeError {
  constructor() {
    super(
      'hashPassword and verifyPassword must both be provided or both omitted. ' +
        'Mixing one custom function with the default PBKDF2 implementation will cause auth failures.',
    );
    this.name = 'EdgePasswordConfigError';
  }
}
