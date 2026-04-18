/**
 * Returns true if the Hono route pattern could match the given literal SSE path.
 * Normalizes trailing slashes. Handles: exact match, :param segments,
 * terminal wildcard *, catch-all /*, and prefix wildcard /path/*.
 */
export function routePatternCanMatchLiteral(pattern: string, literal: string): boolean {
  const norm = (s: string) => s.replace(/\/+$/, '') || '/';
  pattern = norm(pattern);
  literal = norm(literal);

  if (pattern === '/*' || pattern === '*') return true;

  const patSegs = pattern.split('/');
  const litSegs = literal.split('/');

  for (let i = 0; i < patSegs.length; i++) {
    const p = patSegs[i];
    if (p === '*') return true; // terminal wildcard — rest matches
    if (i >= litSegs.length) return false;
    if (p.startsWith(':')) continue; // param segment — matches any
    if (p !== litSegs[i]) return false; // literal mismatch
  }

  return patSegs.length === litSegs.length;
}
