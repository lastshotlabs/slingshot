import { describe, expect, it, mock } from 'bun:test';
import {
  resolveLoggingStrategy,
  resolveNormalizePathStrategy,
  resolveRateLimitKeyStrategy,
  resolveRateLimitSkipStrategy,
  resolveUploadAuthStrategy,
  resolveValidationFormatStrategy,
} from '../../src/lib/manifestStrategies';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeContext(vars: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return {
    get(key: string) {
      return vars[key];
    },
    req: {
      raw: {
        headers: new Headers(headers),
      },
      header(name: string) {
        return headers[name.toLowerCase()];
      },
    },
    env: {},
  } as never; // opaque cast — strategies only read context variables and headers
}

// ---------------------------------------------------------------------------
// Rate limit key strategies
// ---------------------------------------------------------------------------

describe('resolveRateLimitKeyStrategy', () => {
  it('"ip" returns a function that extracts client IP', () => {
    const fn = resolveRateLimitKeyStrategy('ip');
    expect(typeof fn).toBe('function');
  });

  it('"user" falls back to IP when authUserId is absent', () => {
    const fn = resolveRateLimitKeyStrategy('user');
    const c = fakeContext({});
    const key = fn(c);
    // Should return some IP-derived string, not null
    expect(typeof key).toBe('string');
    expect(key.length).toBeGreaterThan(0);
  });

  it('"user" returns userId when present', () => {
    const fn = resolveRateLimitKeyStrategy('user');
    const c = fakeContext({ authUserId: 'usr_123' });
    expect(fn(c)).toBe('usr_123');
  });

  it('"ip+user" prefixes u: for authenticated users', () => {
    const fn = resolveRateLimitKeyStrategy('ip+user');
    const c = fakeContext({ authUserId: 'usr_456' });
    expect(fn(c)).toBe('u:usr_456');
  });

  it('"ip+user" prefixes ip: for unauthenticated users', () => {
    const fn = resolveRateLimitKeyStrategy('ip+user');
    const c = fakeContext({});
    const key = fn(c);
    expect(key.startsWith('ip:')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rate limit skip strategies
// ---------------------------------------------------------------------------

describe('resolveRateLimitSkipStrategy', () => {
  it('"authenticated" returns true when authUserId is set', () => {
    const fn = resolveRateLimitSkipStrategy('authenticated');
    expect(fn(fakeContext({ authUserId: 'usr_1' }))).toBe(true);
  });

  it('"authenticated" returns false when authUserId is null', () => {
    const fn = resolveRateLimitSkipStrategy('authenticated');
    expect(fn(fakeContext({}))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Upload authorization strategies
// ---------------------------------------------------------------------------

describe('resolveUploadAuthStrategy', () => {
  it('"owner" always returns false (framework handles owner check separately)', () => {
    const fn = resolveUploadAuthStrategy('owner');
    expect(fn({ action: 'read', key: 'file.png', userId: 'usr_1' })).toBe(false);
    expect(fn({ action: 'read', key: 'file.png' })).toBe(false);
  });

  it('"authenticated" returns true when userId is present', () => {
    const fn = resolveUploadAuthStrategy('authenticated');
    expect(fn({ action: 'upload', key: 'file.png', userId: 'usr_1' })).toBe(true);
  });

  it('"authenticated" returns false when userId is absent', () => {
    const fn = resolveUploadAuthStrategy('authenticated');
    expect(fn({ action: 'upload', key: 'file.png' })).toBe(false);
  });

  it('"public" always returns true', () => {
    const fn = resolveUploadAuthStrategy('public');
    expect(fn({ action: 'read', key: 'file.png' })).toBe(true);
    expect(fn({ action: 'upload', key: 'file.png' })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Logging strategies
// ---------------------------------------------------------------------------

describe('resolveLoggingStrategy', () => {
  it('"json" calls console.log with JSON.stringify', () => {
    const fn = resolveLoggingStrategy('json');
    const spy = mock((..._args: unknown[]) => {});
    const origLog = console.log;
    console.log = spy as typeof console.log;
    try {
      fn({ method: 'GET', path: '/', statusCode: 200, responseTime: 10 });
      expect(spy).toHaveBeenCalledTimes(1);
      const output = spy.mock.calls[0][0] as string;
      expect(() => JSON.parse(output)).not.toThrow();
      const parsed = JSON.parse(output);
      expect(parsed.method).toBe('GET');
      expect(parsed.statusCode).toBe(200);
    } finally {
      console.log = origLog;
    }
  });

  it('"pretty" formats as "METHOD path status durationms"', () => {
    const fn = resolveLoggingStrategy('pretty');
    const spy = mock((..._args: unknown[]) => {});
    const origLog = console.log;
    console.log = spy as typeof console.log;
    try {
      fn({ method: 'POST', path: '/api/users', statusCode: 201, responseTime: 42 });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toBe('POST /api/users 201 42ms');
    } finally {
      console.log = origLog;
    }
  });
});

// ---------------------------------------------------------------------------
// Metrics path normalization
// ---------------------------------------------------------------------------

describe('resolveNormalizePathStrategy', () => {
  it('"strip-ids" replaces UUIDs with :id', () => {
    const fn = resolveNormalizePathStrategy('strip-ids');
    expect(fn('/users/a1b2c3d4-e5f6-7890-abcd-ef1234567890/profile')).toBe('/users/:id/profile');
  });

  it('"strip-ids" replaces numeric segments with :id', () => {
    const fn = resolveNormalizePathStrategy('strip-ids');
    expect(fn('/posts/12345/comments/67890')).toBe('/posts/:id/comments/:id');
  });

  it('"strip-ids" leaves non-id segments intact', () => {
    const fn = resolveNormalizePathStrategy('strip-ids');
    expect(fn('/api/users/settings')).toBe('/api/users/settings');
  });

  it('"strip-ids" handles root path', () => {
    const fn = resolveNormalizePathStrategy('strip-ids');
    expect(fn('/')).toBe('/');
  });
});

// ---------------------------------------------------------------------------
// Validation error formatting
// ---------------------------------------------------------------------------

describe('resolveValidationFormatStrategy', () => {
  const issues = [
    { path: ['body', 'email'], message: 'Invalid email' },
    { path: ['body', 'name'], message: 'Required' },
    { path: ['body', 'name'], message: 'Too short' },
  ];

  it('"flat" returns a flat array of path.message pairs', () => {
    const fn = resolveValidationFormatStrategy('flat');
    const result = fn(issues, 'req_abc') as {
      error: string;
      details: { path: string; message: string }[];
      requestId: string;
    };
    expect(result.error).toBe('Validation failed');
    expect(result.requestId).toBe('req_abc');
    expect(result.details).toHaveLength(3);
    expect(result.details[0].path).toBe('body.email');
    expect(result.details[0].message).toBe('Invalid email');
  });

  it('"grouped" groups messages by top-level field', () => {
    const fn = resolveValidationFormatStrategy('grouped');
    const result = fn(issues, 'req_xyz') as {
      error: string;
      fields: Record<string, string[]>;
      requestId: string;
    };
    expect(result.error).toBe('Validation failed');
    expect(result.requestId).toBe('req_xyz');
    expect(result.fields['body']).toEqual(['Invalid email', 'Required', 'Too short']);
  });

  it('"grouped" uses _root for issues with empty path', () => {
    const fn = resolveValidationFormatStrategy('grouped');
    const result = fn([{ path: [], message: 'Bad request' }], 'req_1') as {
      fields: Record<string, string[]>;
    };
    expect(result.fields['_root']).toEqual(['Bad request']);
  });
});
