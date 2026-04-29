/** Errors thrown by the Node runtime implementation. */

export class NodeRuntimeError extends Error {
  constructor(message: string) {
    super(`[runtime-node] ${message}`);
    this.name = 'NodeRuntimeError';
  }
}

/** Raised when the Node runtime HTTP server cannot start or serve requests safely. */
export class NodeServerError extends NodeRuntimeError {
  constructor(message: string) {
    super(message);
    this.name = 'NodeServerError';
  }
}

/** Raised when Node runtime WebSocket setup or delivery fails. */
export class NodeWebSocketError extends NodeRuntimeError {
  constructor(message: string) {
    super(message);
    this.name = 'NodeWebSocketError';
  }
}

/** Raised when an incoming request has an invalid Content-Length header. */
export class NodeContentLengthError extends NodeRuntimeError {
  readonly rawValue: string;

  constructor(rawValue: string) {
    super(`invalid Content-Length header: "${rawValue}"`);
    this.name = 'NodeContentLengthError';
    this.rawValue = rawValue;
  }
}

/** Raised when a Node runtime request body exceeds the configured maximum size. */
export class NodeRequestBodyTooLargeError extends NodeRuntimeError {
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(`request body exceeds maximum size of ${maxBytes} bytes`);
    this.name = 'NodeRequestBodyTooLargeError';
    this.maxBytes = maxBytes;
  }
}

/** Raised when the Node runtime cannot complete server shutdown cleanly. */
export class NodeShutdownError extends NodeRuntimeError {
  constructor(message: string) {
    super(message);
    this.name = 'NodeShutdownError';
  }
}
