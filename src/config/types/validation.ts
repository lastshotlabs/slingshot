import type { ValidationErrorFormatter } from '@lastshotlabs/slingshot-core';

export interface ValidationConfig {
  /** Custom formatter for Zod validation errors. Receives issues + requestId, returns the JSON body. */
  formatError?: ValidationErrorFormatter;
}
