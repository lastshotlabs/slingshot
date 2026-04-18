/**
 * Internal adapter interfaces for the polls plugin.
 *
 * NOT exported from the package entry point (Rule 7 — minimal public API).
 * Used by the plugin factory, middleware, and handlers to type the resolved
 * entity adapters without leaking framework generics.
 *
 * @internal
 */
import type { PollRecord, PollVoteRecord } from './public';

/** Resolved Poll entity adapter shape used internally by the plugin. */
export interface PollAdapter {
  getById(id: string): Promise<PollRecord | null>;
  create(input: Record<string, unknown>): Promise<PollRecord>;
  update(id: string, data: Record<string, unknown>): Promise<PollRecord | null>;
  delete(id: string): Promise<boolean>;
  list(opts?: Record<string, unknown>): Promise<{ items: PollRecord[]; cursor?: string }>;
  listBySource(params: { sourceType: string; sourceId: string }): Promise<{ items: PollRecord[] }>;
  clear(): Promise<void>;
}

/** Resolved PollVote entity adapter shape used internally by the plugin. */
export interface PollVoteAdapter {
  getById(id: string): Promise<PollVoteRecord | null>;
  create(input: Record<string, unknown>): Promise<PollVoteRecord>;
  delete(id: string): Promise<boolean>;
  list(opts?: Record<string, unknown>): Promise<{ items: PollVoteRecord[]; cursor?: string }>;
  listByPoll(params: { pollId: string }): Promise<{ items: PollVoteRecord[] }>;
  clear(): Promise<void>;
}
