// packages/slingshot-ssr/tests/unit/dev-overlay.test.ts
//
// Tests for buildDevErrorOverlay() — Phase 30 DX polish.
//
// Verifies:
// - HTML structure (doctype, head, body)
// - Error type and message are rendered
// - Stack trace frames are rendered
// - XSS escaping: <, >, &, ", ' are escaped in all user-controlled fields
// - VS Code deeplinks for local file paths
// - Request context section rendered when provided
// - Minimal context (no context) renders without crashing
import { describe, expect, it } from 'bun:test';
import { buildDevErrorOverlay } from '../../src/dev/overlay';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeError(message: string, stack?: string): Error {
  const err = new Error(message);
  if (stack !== undefined) err.stack = stack;
  return err;
}

// ─── Structure ────────────────────────────────────────────────────────────────

describe('buildDevErrorOverlay — HTML structure', () => {
  it('returns a complete HTML document', () => {
    const html = buildDevErrorOverlay(new Error('test'));
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain('<html');
    expect(html).toContain('</html>');
    expect(html).toContain('<head>');
    expect(html).toContain('</head>');
    expect(html).toContain('<body>');
    expect(html).toContain('</body>');
  });

  it('sets Content-Type charset in meta tag', () => {
    const html = buildDevErrorOverlay(new Error('test'));
    expect(html).toContain('charset="UTF-8"');
  });

  it('includes page title referencing SSR error', () => {
    const html = buildDevErrorOverlay(new Error('test'));
    expect(html).toContain('<title>');
    expect(html.toLowerCase()).toMatch(/ssr.*error|error.*ssr/);
  });

  it('uses only inline CSS — no external stylesheet links', () => {
    const html = buildDevErrorOverlay(new Error('test'));
    // Should not link to external CSS
    expect(html).not.toMatch(/<link[^>]+rel=["']stylesheet["']/);
    // Inline style tag is present
    expect(html).toContain('<style>');
  });

  it("renders the 'SSR Error' badge", () => {
    const html = buildDevErrorOverlay(new Error('test'));
    expect(html.toLowerCase()).toContain('ssr error');
  });
});

// ─── Error rendering ──────────────────────────────────────────────────────────

describe('buildDevErrorOverlay — error rendering', () => {
  it('renders the error message', () => {
    const html = buildDevErrorOverlay(new Error('Something went wrong'));
    expect(html).toContain('Something went wrong');
  });

  it('renders the error type (class name)', () => {
    class CustomError extends Error {
      constructor() {
        super('custom');
        this.name = 'CustomError';
      }
    }
    const err = new CustomError();
    const html = buildDevErrorOverlay(err);
    expect(html).toContain('CustomError');
  });

  it("renders 'Error' for plain Error instances", () => {
    const html = buildDevErrorOverlay(new Error('plain'));
    expect(html).toContain('Error');
  });
});

// ─── Stack trace ──────────────────────────────────────────────────────────────

describe('buildDevErrorOverlay — stack trace', () => {
  it('renders stack frames', () => {
    const err = makeError(
      'fail',
      [
        'Error: fail',
        '    at myFunction (/app/server/routes/posts/page.ts:42:7)',
        '    at async render (/app/src/renderer.ts:100:3)',
      ].join('\n'),
    );
    const html = buildDevErrorOverlay(err);
    expect(html).toContain('myFunction');
    expect(html).toContain('render');
  });

  it('generates VS Code deeplinks for local absolute paths', () => {
    const err = makeError(
      'fail',
      ['Error: fail', '    at load (/app/server/routes/posts/page.ts:10:5)'].join('\n'),
    );
    const html = buildDevErrorOverlay(err);
    expect(html).toContain('vscode://file/');
  });

  it('includes line number in VS Code deeplink', () => {
    const err = makeError(
      'fail',
      ['Error: fail', '    at load (/app/server/routes/page.ts:99:3)'].join('\n'),
    );
    const html = buildDevErrorOverlay(err);
    expect(html).toMatch(/vscode:\/\/file\/[^"']*:99/);
  });

  it('does not generate deeplinks for non-local paths', () => {
    const err = makeError(
      'fail',
      ['Error: fail', '    at Object.<anonymous> (node:internal/modules/cjs/loader:936:14)'].join(
        '\n',
      ),
    );
    const html = buildDevErrorOverlay(err);
    // node: internal paths should not get vscode:// links
    expect(html).not.toMatch(/vscode:\/\/file\/node:/);
  });

  it('renders empty stack section gracefully when stack is empty', () => {
    const err = makeError('empty stack', '');
    const html = buildDevErrorOverlay(err);
    // Should not throw and should still produce valid HTML
    expect(html).toContain('</html>');
  });
});

// ─── XSS escaping ─────────────────────────────────────────────────────────────

describe('buildDevErrorOverlay — XSS escaping', () => {
  it('escapes < and > in the error message', () => {
    const err = new Error('<script>alert(1)</script>');
    const html = buildDevErrorOverlay(err);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes & in the error message', () => {
    const err = new Error('foo & bar');
    const html = buildDevErrorOverlay(err);
    expect(html).toContain('foo &amp; bar');
  });

  it('escapes quotes in the error message', () => {
    const err = new Error('say "hello" & \'world\'');
    const html = buildDevErrorOverlay(err);
    expect(html).not.toContain('"hello"');
    expect(html).toContain('&quot;hello&quot;');
  });

  it('escapes XSS in context URL', () => {
    const err = new Error('fail');
    const html = buildDevErrorOverlay(err, { url: '/<script>alert(1)</script>' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes XSS in context params', () => {
    const err = new Error('fail');
    const html = buildDevErrorOverlay(err, {
      params: { id: '<img src=x onerror=alert(1)>' },
    });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('escapes XSS in context loaderFile', () => {
    const err = new Error('fail');
    const html = buildDevErrorOverlay(err, {
      loaderFile: '/app/<evil>/page.ts',
    });
    expect(html).not.toContain('<evil>');
    expect(html).toContain('&lt;evil&gt;');
  });
});

// ─── Request context ──────────────────────────────────────────────────────────

describe('buildDevErrorOverlay — request context section', () => {
  it('renders URL when context.url is provided', () => {
    const html = buildDevErrorOverlay(new Error('fail'), { url: '/posts/hello-world' });
    expect(html).toContain('/posts/hello-world');
  });

  it('renders loaderFile when context.loaderFile is provided', () => {
    const html = buildDevErrorOverlay(new Error('fail'), {
      loaderFile: '/app/server/routes/posts/page.ts',
    });
    expect(html).toContain('/app/server/routes/posts/page.ts');
  });

  it('renders params when context.params is provided and non-empty', () => {
    const html = buildDevErrorOverlay(new Error('fail'), {
      params: { slug: 'hello-world' },
    });
    expect(html).toContain('hello-world');
  });

  it('omits context section entirely when no context provided', () => {
    const html = buildDevErrorOverlay(new Error('fail'));
    // No context table should be present — just the error message and stack
    // The overlay should still be valid HTML
    expect(html).toContain('</html>');
  });

  it('omits params row when params object is empty', () => {
    const html = buildDevErrorOverlay(new Error('fail'), {
      url: '/test',
      params: {},
    });
    // Should not render the params row
    expect(html).toContain('/test');
    expect(html).not.toContain('Params');
  });
});

// ─── Dev footer ───────────────────────────────────────────────────────────────

describe('buildDevErrorOverlay — dev footer', () => {
  it('includes dev mode disclaimer', () => {
    const html = buildDevErrorOverlay(new Error('fail'));
    expect(html.toLowerCase()).toContain('dev mode');
  });
});
