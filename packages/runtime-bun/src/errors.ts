/** Errors thrown by the Bun runtime implementation. */

export class BunRuntimeError extends Error {
  constructor(message: string) {
    super(`[runtime-bun] ${message}`);
    this.name = 'BunRuntimeError';
  }
}

export class BunServerError extends BunRuntimeError {
  constructor(message: string) {
    super(message);
    this.name = 'BunServerError';
  }
}

export class BunWebSocketError extends BunRuntimeError {
  constructor(message: string) {
    super(message);
    this.name = 'BunWebSocketError';
  }
}

export class BunSqliteError extends BunRuntimeError {
  constructor(message: string) {
    super(message);
    this.name = 'BunSqliteError';
  }
}

export class BunPasswordError extends BunRuntimeError {
  constructor(message: string) {
    super(message);
    this.name = 'BunPasswordError';
  }
}
