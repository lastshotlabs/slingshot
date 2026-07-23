function getMessage(err: unknown): string | null {
  return err instanceof Error ? err.message : null;
}

export function isSqliteMissingColumnError(err: unknown, column: string): boolean {
  const message = getMessage(err);
  if (!message) return false;
  const normalized = message.toLowerCase();
  const expected = column.toLowerCase();
  return (
    normalized.includes(`no such column: ${expected}`) ||
    normalized.includes(`no such column: "${expected}"`)
  );
}

export function isSqliteDuplicateColumnError(err: unknown, column: string): boolean {
  const message = getMessage(err);
  if (!message) return false;
  return message.toLowerCase().includes(`duplicate column name: ${column.toLowerCase()}`);
}

export function isSqliteUnsupportedDropColumnError(err: unknown): boolean {
  const message = getMessage(err);
  if (!message) return false;
  return /near\s+"?DROP"?\s*:\s*syntax error/i.test(message);
}
