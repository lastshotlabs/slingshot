/**
 * Tests createReactEmailRenderer when @react-email/render is not installed.
 * Must be isolated in its own file because mock.module() must be set
 * before the first import of the module under test, and Bun caches modules.
 */
import { describe, expect, it, mock } from 'bun:test';
import { createReactEmailRenderer } from '../../src/renderers/reactEmail.js';

// Simulate package not installed — mock BEFORE importing renderer
mock.module('@react-email/render', () => {
  throw new Error('@react-email/render is not installed');
});

describe('createReactEmailRenderer (@react-email/render not installed)', () => {
  it('not installed → throws Error (not MailSendError), message includes @react-email/render', async () => {
    const MockComponent = mock(() => null) as unknown as any;
    const renderer = createReactEmailRenderer({ templates: { tpl: MockComponent } });

    const err = await renderer.render('tpl', {}).catch(e => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.name).not.toBe('MailSendError');
    expect(err.message).toContain('@react-email/render');
  });
});
