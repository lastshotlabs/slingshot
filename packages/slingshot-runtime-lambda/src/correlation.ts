export function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return null;
}

export function readHeader(
  headers: Record<string, string | undefined> | undefined,
  key: string,
): string | null {
  if (!headers) return null;
  const match = Object.entries(headers).find(([name]) => name.toLowerCase() === key.toLowerCase());
  return match && typeof match[1] === 'string' && match[1].length > 0 ? match[1] : null;
}

export function decodeMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export function decodeBase64JsonOrText(value: string): unknown {
  try {
    const text = Buffer.from(value, 'base64').toString('utf8');
    return decodeMaybeJson(text);
  } catch {
    return value;
  }
}

export function decodeHttpBody(
  body: string | null | undefined,
  isBase64Encoded?: boolean,
): unknown {
  if (!body) return {};
  return isBase64Encoded ? decodeBase64JsonOrText(body) : decodeMaybeJson(body);
}
