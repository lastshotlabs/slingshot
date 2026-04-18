import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { attachContext, createRouter } from '@lastshotlabs/slingshot-core';
import { adaptRegisteredTemplates } from '../../src/lib/authTemplateAdapter.js';

// ---------------------------------------------------------------------------
// Test templates — registered via core's EmailTemplateRegistry
// ---------------------------------------------------------------------------

const MOCK_TEMPLATES: Record<string, { subject: string; html: string; text?: string }> = {
  emailVerification: { subject: 'Verify your email', html: '<p>verify</p>', text: 'verify' },
  passwordReset: { subject: 'Reset your password', html: '<p>reset</p>', text: 'reset' },
  magicLink: { subject: 'Your magic link', html: '<p>magic</p>', text: 'magic' },
  emailOtp: { subject: 'Your OTP', html: '<p>otp</p>', text: 'otp' },
  welcomeEmail: { subject: 'Welcome!', html: '<p>welcome</p>', text: 'welcome' },
  accountDeletion: { subject: 'Account deleted', html: '<p>deleted</p>', text: 'deleted' },
  orgInvitation: { subject: 'You are invited', html: '<p>invite</p>', text: 'invite' },
  // Also register under delivery event aliases (as the auth plugin does)
  email_verification: { subject: 'Verify your email', html: '<p>verify</p>', text: 'verify' },
  password_reset: { subject: 'Reset your password', html: '<p>reset</p>', text: 'reset' },
  magic_link: { subject: 'Your magic link', html: '<p>magic</p>', text: 'magic' },
  email_otp: { subject: 'Your OTP', html: '<p>otp</p>', text: 'otp' },
  welcome: { subject: 'Welcome!', html: '<p>welcome</p>', text: 'welcome' },
  account_deletion: { subject: 'Account deleted', html: '<p>deleted</p>', text: 'deleted' },
  org_invitation: { subject: 'You are invited', html: '<p>invite</p>', text: 'invite' },
};

let app: object;

beforeEach(() => {
  app = createRouter();
  attachContext(app, { app, emailTemplates: new Map(Object.entries(MOCK_TEMPLATES)) } as any);
});

afterEach(() => {});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('adaptRegisteredTemplates', () => {
  it('returns camelCase keys from the registered templates', async () => {
    const result = await adaptRegisteredTemplates(app);

    expect(result['passwordReset']).toBeDefined();
    expect(result['passwordReset'].subject).toBe('Reset your password');
    expect(result['passwordReset'].html).toBe('<p>reset</p>');
    expect(result['passwordReset'].text).toBe('reset');

    expect(result['emailVerification']).toBeDefined();
    expect(result['magicLink']).toBeDefined();
    expect(result['emailOtp']).toBeDefined();
    expect(result['welcomeEmail']).toBeDefined();
    expect(result['accountDeletion']).toBeDefined();
    expect(result['orgInvitation']).toBeDefined();
  });

  it('returns delivery event alias keys (snake_case)', async () => {
    const result = await adaptRegisteredTemplates(app);

    expect(result['password_reset']).toBeDefined();
    expect(result['email_verification']).toBeDefined();
    expect(result['magic_link']).toBeDefined();
    expect(result['email_otp']).toBeDefined();
    expect(result['welcome']).toBeDefined();
    expect(result['account_deletion']).toBeDefined();
    expect(result['org_invitation']).toBeDefined();
  });

  it('all 7 aliases are present', async () => {
    const result = await adaptRegisteredTemplates(app);

    const expectedAliases = [
      'email_verification',
      'password_reset',
      'magic_link',
      'email_otp',
      'welcome',
      'account_deletion',
      'org_invitation',
    ];

    for (const alias of expectedAliases) {
      expect(result[alias]).toBeDefined();
    }
  });

  it('alias values match the camelCase originals', async () => {
    const result = await adaptRegisteredTemplates(app);

    // password_reset should match passwordReset
    expect(result['password_reset'].subject).toBe(result['passwordReset'].subject);
    expect(result['password_reset'].html).toBe(result['passwordReset'].html);
    expect(result['password_reset'].text).toBe(result['passwordReset'].text);

    // welcome maps to welcomeEmail
    expect(result['welcome'].subject).toBe(result['welcomeEmail'].subject);
  });

  it('returns empty map and warns when no templates are registered', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    app = createRouter();
    attachContext(app, { app, emailTemplates: new Map() } as any);
    warnSpy.mockClear(); // clear any framework-level warnings from setup

    const result = await adaptRegisteredTemplates(app);

    expect(Object.keys(result).length).toBe(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnMsg = (warnSpy.mock.calls[0] as string[])[0];
    expect(warnMsg).toContain('no templates found');
    expect(warnMsg).toContain('setupPost');

    warnSpy.mockRestore();
  });
});
