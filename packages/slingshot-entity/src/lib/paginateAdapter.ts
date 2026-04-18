/**
 * Paginated scan over a bare entity adapter.
 *
 * Wraps the adapter's `list()` method as an `AsyncGenerator`, paging through
 * all records in `pageSize` batches (default 500) and yielding each document.
 * Advances via cursor until the response signals no more pages (`hasMore ===
 * false`, or `nextCursor`/`cursor` is absent).
 *
 * Used by the entity plugin to register reindex sources for the search admin
 * rebuild route via `RESOLVE_REINDEX_SOURCE`.
 *
 * @param adapter - Any object with a `list()` method matching `BareEntityAdapterCrud`.
 * @param pageSize - Number of records to fetch per page. Defaults to 500.
 */
export async function* paginateAdapter(
  adapter: {
    list(opts: { limit?: number; cursor?: string }): Promise<{
      items: unknown[];
      cursor?: string;
      nextCursor?: string;
      hasMore?: boolean;
    }>;
  },
  pageSize = 500,
): AsyncGenerator<Record<string, unknown>> {
  let cursor: string | undefined;

  for (;;) {
    const page = await adapter.list({ limit: pageSize, cursor });

    for (const item of page.items) {
      yield item as Record<string, unknown>;
    }

    const next = page.nextCursor ?? page.cursor;
    if (!next || page.hasMore === false) break;
    cursor = next;
  }
}
