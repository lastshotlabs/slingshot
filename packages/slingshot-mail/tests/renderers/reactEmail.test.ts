import { afterEach, describe, expect, it, mock } from 'bun:test';
import { TemplateNotFoundError } from '@lastshotlabs/slingshot-core';
import { createReactEmailRenderer } from '../../src/renderers/reactEmail.js';

// React component mocks — cast to any since the mock return type doesn't satisfy ComponentType.
function asCmp(fn: unknown) {
  return fn as any;
}

// ---------------------------------------------------------------------------
// Mock @react-email/render BEFORE importing the renderer.
// Bun evaluates mock.module() at call time so it must come first.
// ---------------------------------------------------------------------------

const mockRender = mock(async (_element: unknown, opts?: { plainText?: boolean }) => {
  if (opts?.plainText) return 'Plain text content';
  return '<html><body>Rendered HTML</body></html>';
});

mock.module('@react-email/render', () => ({
  render: mockRender,
}));

afterEach(() => {
  mockRender.mockReset();
  mockRender.mockImplementation(async (_element: unknown, opts?: { plainText?: boolean }) => {
    if (opts?.plainText) return 'Plain text content';
    return '<html><body>Rendered HTML</body></html>';
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createReactEmailRenderer', () => {
  it('valid template → render() called with Component(data); returns { html, text, subject }', async () => {
    const MockComponent = mock((data: Record<string, unknown>) => ({ type: 'div', props: data }));

    const renderer = createReactEmailRenderer({
      templates: { welcome: asCmp(MockComponent) },
      subjects: { welcome: 'Welcome!' },
    });

    const result = await renderer.render('welcome', { name: 'Alice' });

    expect(MockComponent).toHaveBeenCalledTimes(1);
    expect(MockComponent).toHaveBeenCalledWith({ name: 'Alice' });
    expect(mockRender).toHaveBeenCalled();
    expect(result.html).toBe('<html><body>Rendered HTML</body></html>');
    expect(result.text).toBe('Plain text content');
    expect(result.subject).toBe('Welcome!');
  });

  it('subjects? config sets subject for matching template', async () => {
    const MockComponent = mock(() => null);

    const renderer = createReactEmailRenderer({
      templates: {
        invoice: asCmp(MockComponent),
        receipt: asCmp(MockComponent),
      },
      subjects: {
        invoice: 'Your Invoice',
        receipt: 'Your Receipt',
      },
    });

    const invoiceResult = await renderer.render('invoice', {});
    expect(invoiceResult.subject).toBe('Your Invoice');

    const receiptResult = await renderer.render('receipt', {});
    expect(receiptResult.subject).toBe('Your Receipt');
  });

  it('no subjects config → subject is undefined', async () => {
    const MockComponent = mock(() => null);
    const renderer = createReactEmailRenderer({ templates: { tpl: asCmp(MockComponent) } });

    const result = await renderer.render('tpl', {});
    expect(result.subject).toBeUndefined();
  });

  it('unknown template → TemplateNotFoundError with correct template name', async () => {
    const renderer = createReactEmailRenderer({
      templates: { known: asCmp(mock(() => null)) },
    });

    const err = await renderer.render('unknown-template', {}).catch(e => e);

    expect(err).toBeInstanceOf(TemplateNotFoundError);
    expect((err as TemplateNotFoundError).templateName).toBe('unknown-template');
    expect(err.message).toContain('unknown-template');
  });

  it('listTemplates() returns Object.keys(config.templates)', async () => {
    const renderer = createReactEmailRenderer({
      templates: {
        welcome: asCmp(mock(() => null)),
        invite: asCmp(mock(() => null)),
        reset: asCmp(mock(() => null)),
      },
    });

    const templates = await renderer.listTemplates!();
    expect(templates).toHaveLength(3);
    expect(templates).toContain('welcome');
    expect(templates).toContain('invite');
    expect(templates).toContain('reset');
  });
});
