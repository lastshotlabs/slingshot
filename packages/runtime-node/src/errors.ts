/** Errors thrown by the Node runtime implementation. */

export class NodeRuntimeError extends Error {
  constructor(message: string) {
    super(`[runtime-node] ${message}`);
    this.name = 'NodeRuntimeError';
  }
}

export class NodeServerError extends NodeRuntimeError {
  constructor(message: string) {
    super(message);
    this.name = 'NodeServerError';
  }
}

export class NodeWebSocketError extends NodeRuntimeError {
  constructor(message: string) {
    super(message);
    this.name = 'NodeWebSocketError';
  }
}

export class NodeContentLengthError extends NodeRuntimeError {
  readonly rawValue: string;

  constructor(rawValue: string) {
    super(`invalid Content-Length header: "${rawValue}"`);
    this.name = 'NodeContentLengthError';
    this.rawValue = rawValue;
  }
}

export class NodeRequestBodyTooLargeError extends NodeRuntimeError {
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(`request body exceeds maximum size of ${maxBytes} bytes`);
    this.name = 'NodeRequestBodyTooLargeError';
    this.maxBytes = maxBytes;
  }
}

export class NodeShutdownError extends NodeRuntimeError {
  constructor(message: string) {
    super(message);
    this.name = 'NodeShutdownError';
  }
}
