/** Errors thrown by the orchestration plugin integration layer. */

export class InvalidResolverResultError extends Error {
  readonly code = 'INVALID_RESOLVER_RESULT';
  constructor(detail: string) {
    super(`Invalid resolveRequestContext result: ${detail}`);
    this.name = 'InvalidResolverResultError';
  }
}
