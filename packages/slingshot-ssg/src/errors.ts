/** Errors thrown by the SSG package. */

export class SsgError extends Error {
  constructor(message: string) {
    super(`[slingshot-ssg] ${message}`);
    this.name = 'SsgError';
  }
}

export class SsgCrawlError extends SsgError {
  constructor(message: string) {
    super(message);
    this.name = 'SsgCrawlError';
  }
}

export class SsgRenderError extends SsgError {
  readonly url: string;

  constructor(url: string, cause?: unknown) {
    super(`render failed for ${url}${cause instanceof Error ? `: ${cause.message}` : ''}`);
    this.name = 'SsgRenderError';
    this.url = url;
    if (cause !== undefined) this.cause = cause as Error;
  }
}

export class SsgConfigError extends SsgError {
  constructor(message: string) {
    super(message);
    this.name = 'SsgConfigError';
  }
}

export class SsgCliArgError extends SsgError {
  constructor(flag: string, raw: string) {
    super(`--${flag} must be a positive integer, got "${raw}"`);
    this.name = 'SsgCliArgError';
  }
}
