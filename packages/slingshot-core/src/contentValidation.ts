import { MAX_CONTENT_ATTACHMENTS, MAX_CONTENT_MENTIONS } from './content';
import type { AssetRef } from './content';
import { assetRefSchema } from './content.schemas';

/**
 * Validate and cap a mentions array from a content request body.
 *
 * - Filters to unique string values.
 * - Caps at `MAX_CONTENT_MENTIONS`.
 * - Returns a frozen array.
 *
 * @param raw - The raw mentions array from the request body (may be `undefined`).
 * @returns Frozen array of validated, unique mention user IDs.
 */
export function validateMentions(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return Object.freeze([]);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || item.length === 0) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    result.push(item);
    if (result.length >= MAX_CONTENT_MENTIONS) break;
  }
  return Object.freeze(result);
}

/**
 * Validate and cap a broadcast mentions array.
 *
 * - Only allows `'everyone'` and `'here'`.
 * - Returns a frozen array of unique values.
 *
 * @param raw - The raw broadcast mentions array from the request body.
 * @returns Frozen array of validated broadcast mention targets.
 */
export function validateBroadcastMentions(raw: unknown): readonly ('everyone' | 'here')[] {
  if (!Array.isArray(raw)) return Object.freeze([]);
  const seen = new Set<string>();
  const result: ('everyone' | 'here')[] = [];
  for (const item of raw) {
    if (item !== 'everyone' && item !== 'here') continue;
    const target = item as 'everyone' | 'here';
    if (seen.has(target)) continue;
    seen.add(target);
    result.push(target);
  }
  return Object.freeze(result);
}

/**
 * Validate and cap an attachments array against the AssetRef schema.
 *
 * - Validates each entry against `assetRefSchema`.
 * - Caps at `MAX_CONTENT_ATTACHMENTS`.
 * - Silently drops invalid entries.
 * - Returns a frozen array.
 *
 * @param raw - The raw attachments array from the request body.
 * @returns Frozen array of validated AssetRef objects.
 */
export function validateAttachments(raw: unknown): readonly AssetRef[] {
  if (!Array.isArray(raw)) return Object.freeze([]);
  const result: AssetRef[] = [];
  for (const item of raw) {
    if (result.length >= MAX_CONTENT_ATTACHMENTS) break;
    const parsed = assetRefSchema.safeParse(item);
    if (parsed.success) {
      result.push(Object.freeze(parsed.data) as AssetRef);
    }
  }
  return Object.freeze(result);
}
