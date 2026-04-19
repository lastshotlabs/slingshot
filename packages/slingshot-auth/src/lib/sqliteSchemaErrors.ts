function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getMessage(err: unknown): string | null {
  return err instanceof Error ? err.message : null;
}

export function isSqliteMissingColumnError(err: unknown, column: string): boolean {
  const message = getMessage(err);
  if (!message) return false;
  const escaped = escapeRegExp(column);
  return new RegExp(`no such column:\\s*"?${escaped}"?`, 'i').test(message);
}

export function isSqliteDuplicateColumnError(err: unknown, column: string): boolean {
  const message = getMessage(err);
  if (!message) return false;
  const escaped = escapeRegExp(column);
  return new RegExp(`duplicate column name:\\s*${escaped}`, 'i').test(message);
}

export function isSqliteUnsupportedDropColumnError(err: unknown): boolean {
  const message = getMessage(err);
  if (!message) return false;
  return /near\s+"?DROP"?\s*:\s*syntax error/i.test(message);
}
