/** Errors thrown by the SSG package. */

export class SsgError extends Error {
  constructor(message: string) {
    super(`[slingshot-ssg] ${message}`);
    this.name = 'SsgError';
  }
}

/** Raised when the SSG crawler cannot discover or normalize routes. */
export class SsgCrawlError extends SsgError {
  constructor(message: string) {
    super(message);
    this.name = 'SsgCrawlError';
  }
}

/** Raised when static rendering fails for a specific URL. */
export class SsgRenderError extends SsgError {
  readonly url: string;

  constructor(url: string, cause?: unknown) {
    super(`render failed for ${url}${cause instanceof Error ? `: ${cause.message}` : ''}`);
    this.name = 'SsgRenderError';
    this.url = url;
    if (cause !== undefined) this.cause = cause as Error;
  }
}

/** Raised when SSG configuration is invalid or incomplete. */
export class SsgConfigError extends SsgError {
  constructor(message: string) {
    super(message);
    this.name = 'SsgConfigError';
  }
}

/** Raised when an SSG CLI argument fails validation. */
export class SsgCliArgError extends SsgError {
  constructor(flag: string, raw: string) {
    super(`--${flag} must be a positive integer, got "${raw}"`);
    this.name = 'SsgCliArgError';
  }
}
