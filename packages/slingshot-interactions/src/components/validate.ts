import { componentTreeSchema } from './schema';
import type { ComponentTree } from './types';

/**
 * Validate an arbitrary value as a component tree.
 *
 * @param input - Candidate component payload.
 * @returns Parsed component tree.
 */
export function validateComponentTree(input: unknown): ComponentTree {
  return componentTreeSchema.parse(input);
}
