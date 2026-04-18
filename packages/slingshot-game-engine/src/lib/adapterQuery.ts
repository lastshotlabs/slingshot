function hasItemsCollection(result: unknown): result is { items: Record<string, unknown>[] } {
  if (typeof result !== 'object' || result === null) {
    return false;
  }

  const { items } = result as { items?: unknown };
  return Array.isArray(items);
}

export async function listAdapterRecords(
  adapter: {
    find?: (filter: Record<string, unknown>) => Promise<unknown>;
    list?: (filter: Record<string, unknown>) => Promise<unknown>;
  },
  filter: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  if (typeof adapter.find === 'function') {
    const result = await adapter.find(filter);
    return Array.isArray(result) ? (result as Record<string, unknown>[]) : [];
  }

  if (typeof adapter.list === 'function') {
    const result = await adapter.list(filter);
    if (Array.isArray(result)) return result as Record<string, unknown>[];
    if (hasItemsCollection(result)) {
      return result.items;
    }
  }

  return [];
}
