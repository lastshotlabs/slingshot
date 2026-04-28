/**
 * Per-table serialization helper for the in-memory entity backend.
 *
 * Bun and Node single-threaded JavaScript would make a synchronous
 * read-then-write sequence "naturally" atomic — but the moment any
 * step on the path returns a Promise (lazy schema, audit hooks, async
 * defaults, etc.), unrelated awaits from a sibling caller can interleave
 * and the read-modify-write sandwich silently breaks. This helper turns
 * those sequences into a serialized chain on a per-store basis.
 *
 * **How it works:**
 * Each in-memory entity adapter owns a `Map<pk, entry>` store — that map
 * is the table. We hang a single tail-of-chain `Promise` off each store
 * via a `WeakMap<store, Promise>`. Every wrapped call awaits the tail,
 * runs its own work, and replaces the tail with its own promise. This
 * gives FIFO serialization with no busy-waiting and no shared global
 * state across stores; two different stores never block each other.
 *
 * The `WeakMap` keying lets store garbage-collection clean up the chain
 * automatically — there is nothing to dispose.
 *
 * **What this protects:**
 * - `op.upsert` (find-or-insert) — no duplicate rows under contention
 * - `op.transition` / `op.fieldUpdate` (find-then-update)
 * - `op.arrayPush` / `op.arrayPull` / `op.arraySet` / `op.increment`
 *   (read-then-write on the same record)
 * - `op.batch` action='update' or 'delete' (multi-row mutation)
 * - `EntityAdapter.create` / `EntityAdapter.update` (unique-constraint
 *   check + write)
 *
 * **What this does NOT protect:**
 * - Pure readers (`getById`, `list`, `lookup`, `exists`, `aggregate`,
 *   `derive`) do not need serialization; concurrent reads are safe by
 *   construction in JS.
 * - Cross-table consistency. Atomicity is per-store, not global. A
 *   transaction across two adapters still requires the composite
 *   transaction op.
 *
 * Redis intentionally stays unprotected here — it is a different runtime
 * with its own concurrency model and a separate fix scope.
 */

const tails = new WeakMap<object, Promise<unknown>>();

/**
 * Serialize an async unit of work on a per-store FIFO chain.
 *
 * The work runs only after every previously-scheduled call on the same
 * store has settled, including ones that threw. Errors do not poison the
 * chain — subsequent callers proceed normally with a fresh tail.
 *
 * @param store - The in-memory `Map` representing the entity table.
 *   Used as the WeakMap key; identity is what matters, not contents.
 * @param work - Async work to run under the lock. May read or write the
 *   store; both are safe because the chain is serialized.
 * @returns A promise that resolves with `work`'s result, or rejects with
 *   `work`'s error. Either outcome unblocks the next caller.
 */
export function serializeOnStore<T>(store: object, work: () => Promise<T> | T): Promise<T> {
  const previous = tails.get(store) ?? Promise.resolve();
  const next = previous.then(
    () => work(),
    () => work(),
  );
  // Swallow rejection on the stored tail so unrelated future callers
  // do not see an unhandled rejection from a prior failure. The original
  // promise (`next`) still rejects to the caller that scheduled this work.
  tails.set(
    store,
    next.catch(() => undefined),
  );
  return next;
}
