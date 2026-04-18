import { describe, expect, it } from 'bun:test';
import { TemplateNotFoundError } from '@lastshotlabs/slingshot-core';
import { createRawHtmlRenderer } from '../../src/renderers/rawHtml.js';

describe('createRawHtmlRenderer', () => {
  const renderer = createRawHtmlRenderer({
    templates: {
      welcome: {
        subject: 'Welcome to {{appName}}',
        html: '<p>Hello {{name}}, welcome to {{appName}}!</p>',
        text: 'Hello {{name}}, welcome to {{appName}}!',
      },
      noSubject: {
        html: '<p>No subject here</p>',
      },
    },
  });

  it('renders a template with variable interpolation', async () => {
    const result = await renderer.render('welcome', { appName: 'Slingshot', name: 'Alice' });
    expect(result.subject).toBe('Welcome to Slingshot');
    expect(result.html).toBe('<p>Hello Alice, welcome to Slingshot!</p>');
    expect(result.text).toBe('Hello Alice, welcome to Slingshot!');
  });

  it('leaves unknown variables as empty string', async () => {
    const result = await renderer.render('welcome', { appName: 'Slingshot' });
    // name is missing — becomes ''
    expect(result.html).toBe('<p>Hello , welcome to Slingshot!</p>');
  });

  it('returns undefined subject when template has no subject', async () => {
    const result = await renderer.render('noSubject', {});
    expect(result.subject).toBeUndefined();
    expect(result.html).toBe('<p>No subject here</p>');
  });

  it('throws TemplateNotFoundError for unknown template', async () => {
    const err = await renderer.render('nonexistent', {}).catch(e => e);
    expect(err).toBeInstanceOf(TemplateNotFoundError);
    expect((err as TemplateNotFoundError).templateName).toBe('nonexistent');
    expect(err.message).toContain('nonexistent');
  });

  it('lists available templates', async () => {
    const templates = await renderer.listTemplates!();
    expect(templates).toContain('welcome');
    expect(templates).toContain('noSubject');
    expect(templates).toHaveLength(2);
  });

  it('handles numeric values in interpolation', async () => {
    const numRenderer = createRawHtmlRenderer({
      templates: {
        expiry: { html: '<p>Expires in {{minutes}} minutes</p>' },
      },
    });
    const result = await numRenderer.render('expiry', { minutes: 30 });
    expect(result.html).toBe('<p>Expires in 30 minutes</p>');
  });
});
