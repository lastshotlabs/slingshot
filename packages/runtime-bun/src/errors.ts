/** Errors thrown by the Bun runtime implementation. */

export class BunRuntimeError extends Error {
  constructor(message: string) {
    super(`[runtime-bun] ${message}`);
    this.name = 'BunRuntimeError';
  }
}

/** Raised when the Bun runtime HTTP server cannot start or serve requests safely. */
export class BunServerError extends BunRuntimeError {
  constructor(message: string) {
    super(message);
    this.name = 'BunServerError';
  }
}

/** Raised when Bun runtime WebSocket setup or delivery fails. */
export class BunWebSocketError extends BunRuntimeError {
  constructor(message: string) {
    super(message);
    this.name = 'BunWebSocketError';
  }
}

/** Raised when Bun SQLite runtime operations fail. */
export class BunSqliteError extends BunRuntimeError {
  constructor(message: string) {
    super(message);
    this.name = 'BunSqliteError';
  }
}

/** Raised when Bun password hashing or verification cannot complete safely. */
export class BunPasswordError extends BunRuntimeError {
  constructor(message: string) {
    super(message);
    this.name = 'BunPasswordError';
  }
}
