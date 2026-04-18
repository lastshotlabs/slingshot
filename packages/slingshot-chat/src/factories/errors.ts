// packages/slingshot-chat/src/factories/errors.ts

/**
 * Thrown when a repository backend operation has not been implemented yet.
 * Replace with actual implementation — do not catch and ignore.
 */
export class ChatRepoNotImplementedError extends Error {
  constructor(backend: string, method: string) {
    super(`[slingshot-chat] ${backend} backend: ${method}() not implemented`);
    this.name = 'ChatRepoNotImplementedError';
  }
}
