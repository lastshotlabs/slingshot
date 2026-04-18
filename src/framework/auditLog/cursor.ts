import { HttpError } from '@lastshotlabs/slingshot-core';

interface CursorPayload {
  t: string; // createdAt ISO string
  id: string;
}

export function encodeCursor(createdAt: string, id: string): string {
  return btoa(JSON.stringify({ t: createdAt, id }));
}

export function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const parsed = JSON.parse(atob(cursor)) as Record<string, unknown>;
    if (
      typeof parsed.t === 'string' &&
      parsed.t.length > 0 &&
      !isNaN(Date.parse(parsed.t)) &&
      typeof parsed.id === 'string' &&
      parsed.id.length > 0
    ) {
      return { t: parsed.t, id: parsed.id };
    }
  } catch {
    // malformed base64 or JSON
  }
  return null;
}

export function decodeCursorOrThrow(cursor: string): CursorPayload {
  const c = decodeCursor(cursor);
  if (!c) throw new HttpError(400, 'Invalid pagination cursor');
  return c;
}
