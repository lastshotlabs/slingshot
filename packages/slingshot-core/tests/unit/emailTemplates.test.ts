import { describe, expect, test } from 'bun:test';
import { attachContext } from '../../src/context/contextStore';
import { getEmailTemplate, getEmailTemplates } from '../../src/emailTemplates';
import type { EmailTemplate } from '../../src/emailTemplates';

/**
 * Build a minimal fake SlingshotContext with only `emailTemplates` populated.
 * We attach it to a carrier object via attachContext so resolveContext works.
 */
function makeCarrier(templates: Map<string, EmailTemplate>) {
  const ctx = { emailTemplates: templates } as any;
  const carrier = {};
  attachContext(carrier, ctx);
  return carrier;
}

const welcomeTemplate: EmailTemplate = {
  subject: 'Welcome!',
  html: '<h1>Welcome</h1>',
};

const resetTemplate: EmailTemplate = {
  subject: 'Password Reset',
  html: '<p>Reset your password</p>',
};

describe('getEmailTemplates', () => {
  test('returns all templates as a plain object', () => {
    const templates = new Map<string, EmailTemplate>([
      ['welcome', welcomeTemplate],
      ['password-reset', resetTemplate],
    ]);
    const carrier = makeCarrier(templates);
    const result = getEmailTemplates(carrier);
    expect(result).toEqual({
      welcome: welcomeTemplate,
      'password-reset': resetTemplate,
    });
  });

  test('returns empty object when no templates are registered', () => {
    const carrier = makeCarrier(new Map());
    const result = getEmailTemplates(carrier);
    expect(result).toEqual({});
  });

  test('returns a snapshot — mutations do not affect the source', () => {
    const templates = new Map<string, EmailTemplate>([['welcome', welcomeTemplate]]);
    const carrier = makeCarrier(templates);
    const snapshot = getEmailTemplates(carrier);
    snapshot['injected'] = resetTemplate;
    // Original map unchanged
    expect(templates.has('injected')).toBe(false);
  });
});

describe('getEmailTemplate', () => {
  test('returns the template for an existing key', () => {
    const templates = new Map<string, EmailTemplate>([['welcome', welcomeTemplate]]);
    const carrier = makeCarrier(templates);
    expect(getEmailTemplate(carrier, 'welcome')).toBe(welcomeTemplate);
  });

  test('returns null for a non-existent key', () => {
    const templates = new Map<string, EmailTemplate>([['welcome', welcomeTemplate]]);
    const carrier = makeCarrier(templates);
    expect(getEmailTemplate(carrier, 'does-not-exist')).toBeNull();
  });

  test('returns null (not undefined) for missing key', () => {
    const carrier = makeCarrier(new Map());
    const result = getEmailTemplate(carrier, 'missing');
    expect(result).toBeNull();
    expect(result).not.toBeUndefined();
  });
});
