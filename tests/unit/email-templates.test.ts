import { renderTemplate, templates } from '@auth/lib/emailTemplates';
import type { EmailTemplate } from '@auth/lib/emailTemplates';
import { describe, expect, test } from 'bun:test';

// ---------------------------------------------------------------------------
// renderTemplate
// ---------------------------------------------------------------------------

describe('renderTemplate', () => {
  const baseTemplate: EmailTemplate = {
    subject: 'Hello {{name}}',
    html: '<p>Hi {{name}}, your code is {{code}}</p>',
    text: 'Hi {{name}}, your code is {{code}}',
  };

  test('substitutes all {{var}} placeholders in subject, html, and text', () => {
    const rendered = renderTemplate(baseTemplate, { name: 'Alice', code: '123456' });
    expect(rendered.subject).toBe('Hello Alice');
    expect(rendered.html).toBe('<p>Hi Alice, your code is 123456</p>');
    expect(rendered.text).toBe('Hi Alice, your code is 123456');
  });

  test('substitutes numeric values as strings', () => {
    const rendered = renderTemplate(baseTemplate, { name: 'Bob', code: 999 });
    expect(rendered.text).toBe('Hi Bob, your code is 999');
  });

  test('unknown variables are left as-is', () => {
    const rendered = renderTemplate(baseTemplate, { name: 'Carol' });
    // {{code}} is unknown — left unchanged
    expect(rendered.text).toBe('Hi Carol, your code is {{code}}');
  });

  test('does not mutate the original template', () => {
    const original = { ...baseTemplate };
    renderTemplate(baseTemplate, { name: 'Dave', code: 'abc' });
    expect(baseTemplate.subject).toBe(original.subject);
    expect(baseTemplate.html).toBe(original.html);
    expect(baseTemplate.text).toBe(original.text);
  });

  test('substitutes the same variable multiple times', () => {
    const t: EmailTemplate = {
      subject: '{{app}} — {{app}}',
      html: '{{app}} {{app}}',
      text: '{{app}} {{app}}',
    };
    const rendered = renderTemplate(t, { app: 'Acme' });
    expect(rendered.subject).toBe('Acme — Acme');
    expect(rendered.html).toBe('Acme Acme');
  });

  test('handles empty vars object (leaves all placeholders)', () => {
    const rendered = renderTemplate(baseTemplate, {});
    expect(rendered.subject).toBe('Hello {{name}}');
  });
});

// ---------------------------------------------------------------------------
// Built-in templates — render without errors with documented variables
// ---------------------------------------------------------------------------

describe('built-in templates', () => {
  test('emailVerification renders with documented variables', () => {
    const rendered = renderTemplate(templates.emailVerification, {
      appName: 'MyApp',
      verificationLink: 'https://example.com/verify?token=abc',
      expiryMinutes: '1440',
    });
    expect(rendered.subject).toBe('Verify your email');
    expect(rendered.html).toContain('MyApp');
    expect(rendered.html).toContain('https://example.com/verify?token=abc');
    expect(rendered.html).toContain('1440');
    expect(rendered.text).toContain('https://example.com/verify?token=abc');
    // No unreplaced placeholders for documented vars
    expect(rendered.html).not.toContain('{{appName}}');
    expect(rendered.html).not.toContain('{{verificationLink}}');
    expect(rendered.html).not.toContain('{{expiryMinutes}}');
  });

  test('passwordReset renders with documented variables', () => {
    const rendered = renderTemplate(templates.passwordReset, {
      appName: 'MyApp',
      resetLink: 'https://example.com/reset?token=xyz',
      expiryMinutes: '60',
    });
    expect(rendered.subject).toBe('Reset your password');
    expect(rendered.html).toContain('https://example.com/reset?token=xyz');
    expect(rendered.text).toContain('https://example.com/reset?token=xyz');
    expect(rendered.html).not.toContain('{{resetLink}}');
  });

  test('magicLink renders with documented variables', () => {
    const rendered = renderTemplate(templates.magicLink, {
      appName: 'MyApp',
      magicLink: 'https://example.com/magic?token=def',
      expiryMinutes: '15',
    });
    expect(rendered.subject).toBe('Your sign-in link');
    expect(rendered.html).toContain('https://example.com/magic?token=def');
    expect(rendered.html).not.toContain('{{magicLink}}');
  });

  test('emailOtp renders with documented variables', () => {
    const rendered = renderTemplate(templates.emailOtp, {
      appName: 'MyApp',
      code: '847291',
      expiryMinutes: '5',
    });
    expect(rendered.subject).toBe('Your verification code');
    expect(rendered.html).toContain('847291');
    expect(rendered.text).toContain('847291');
    expect(rendered.html).not.toContain('{{code}}');
  });

  test('welcomeEmail renders with documented variables', () => {
    const rendered = renderTemplate(templates.welcomeEmail, {
      appName: 'MyApp',
      identifier: 'alice@example.com',
    });
    expect(rendered.subject).toBe('Welcome to MyApp');
    expect(rendered.html).toContain('alice@example.com');
    expect(rendered.text).toContain('alice@example.com');
    expect(rendered.html).not.toContain('{{appName}}');
    expect(rendered.html).not.toContain('{{identifier}}');
  });

  test('accountDeletion renders with documented variables', () => {
    const rendered = renderTemplate(templates.accountDeletion, {
      appName: 'MyApp',
      cancelLink: 'https://example.com/cancel?token=ghi',
      gracePeriodHours: '24',
    });
    expect(rendered.subject).toBe('Account deletion scheduled');
    expect(rendered.html).toContain('https://example.com/cancel?token=ghi');
    expect(rendered.html).toContain('24');
    expect(rendered.html).not.toContain('{{cancelLink}}');
    expect(rendered.html).not.toContain('{{gracePeriodHours}}');
  });

  test('orgInvitation renders with documented variables', () => {
    const rendered = renderTemplate(templates.orgInvitation, {
      appName: 'MyApp',
      orgName: 'ACME Corp',
      invitationLink: 'https://example.com/invite?token=jkl',
      expiryDays: '7',
    });
    expect(rendered.subject).toBe("You've been invited to join ACME Corp");
    expect(rendered.html).toContain('ACME Corp');
    expect(rendered.html).toContain('https://example.com/invite?token=jkl');
    expect(rendered.html).toContain('7');
    expect(rendered.html).not.toContain('{{orgName}}');
    expect(rendered.html).not.toContain('{{invitationLink}}');
  });
});

// ---------------------------------------------------------------------------
// HTML templates — no external URLs (inline CSS only)
// ---------------------------------------------------------------------------

describe('HTML templates — inline CSS only, no external URLs', () => {
  const externalUrlPattern = /https?:\/\/(?!example\.com|{{)/;

  for (const [name, template] of Object.entries(templates)) {
    test(`${name} HTML contains no external URLs`, () => {
      // Render with dummy vars so {{placeholders}} don't skew the check
      const rendered = renderTemplate(template, {
        appName: 'Test',
        verificationLink: 'https://example.com/v',
        resetLink: 'https://example.com/r',
        magicLink: 'https://example.com/m',
        invitationLink: 'https://example.com/i',
        cancelLink: 'https://example.com/c',
        code: '000000',
        identifier: 'test@example.com',
        expiryMinutes: '60',
        expiryDays: '7',
        gracePeriodHours: '24',
        orgName: 'Test Org',
      });
      expect(externalUrlPattern.test(rendered.html)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// templates object completeness
// ---------------------------------------------------------------------------

describe('templates object', () => {
  test('contains all 7 built-in templates', () => {
    const expected = [
      'emailVerification',
      'passwordReset',
      'magicLink',
      'emailOtp',
      'welcomeEmail',
      'accountDeletion',
      'orgInvitation',
    ];
    for (const key of expected) {
      expect(templates).toHaveProperty(key);
      expect(typeof templates[key].subject).toBe('string');
      expect(typeof templates[key].html).toBe('string');
      expect(typeof templates[key].text).toBe('string');
    }
  });
});
