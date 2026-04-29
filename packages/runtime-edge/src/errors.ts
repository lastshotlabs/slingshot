/** Errors thrown by the Edge runtime implementation. */

export class EdgeRuntimeError extends Error {
  constructor(message: string) {
    super(`[runtime-edge] ${message}`);
    this.name = 'EdgeRuntimeError';
  }
}

export class EdgeUnsupportedError extends EdgeRuntimeError {
  constructor(feature: string) {
    super(`${feature} is not available in the Edge runtime`);
    this.name = 'EdgeUnsupportedError';
  }
}

export class EdgeFileReadError extends EdgeRuntimeError {
  readonly filePath: string;

  constructor(filePath: string, reason: string) {
    super(`file read error for "${filePath}": ${reason}`);
    this.name = 'EdgeFileReadError';
    this.filePath = filePath;
  }
}

export class EdgeFileSizeExceededError extends EdgeRuntimeError {
  readonly filePath: string;
  readonly maxBytes: number;
  readonly actualBytes: number;

  constructor(filePath: string, maxBytes: number, actualBytes: number) {
    super(`file "${filePath}" exceeds max size (${actualBytes} > ${maxBytes} bytes)`);
    this.name = 'EdgeFileSizeExceededError';
    this.filePath = filePath;
    this.maxBytes = maxBytes;
    this.actualBytes = actualBytes;
  }
}

export class EdgePasswordConfigError extends EdgeRuntimeError {
  constructor() {
    super('hashPassword and verifyPassword must both be provided or both omitted');
    this.name = 'EdgePasswordConfigError';
  }
}
