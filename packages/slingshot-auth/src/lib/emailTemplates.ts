/**
 * Built-in email templates with variable substitution.
 *
 * Templates use {{variableName}} placeholders. Unknown variables are left as-is.
 * All templates use inline CSS only — no external CDN dependencies.
 */
import type { EmailTemplate } from '@lastshotlabs/slingshot-core';

export type { EmailTemplate } from '@lastshotlabs/slingshot-core';

/**
 * Variable substitution map passed to `renderTemplate`.
 * Keys correspond to `{{variableName}}` placeholders; values are coerced to strings.
 */
export interface TemplateVariables {
  [key: string]: string | number;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * Renders an `EmailTemplate` by substituting `{{variableName}}` placeholders with the
 * provided variable values. Placeholders with no corresponding key are left unchanged.
 *
 * HTML body values are HTML-escaped to prevent XSS injection. The `subject` and `text`
 * fields are plain text and are substituted without escaping.
 *
 * @param template - The template to render. Use `templates.*` for the built-in set.
 * @param vars - Map of variable names to their string/number values.
 * @returns A new `EmailTemplate` with all known placeholders replaced.
 *
 * @example
 * import { renderTemplate, templates } from '@lastshotlabs/slingshot-auth';
 *
 * const rendered = renderTemplate(templates.emailVerification, {
 *   appName: 'Acme',
 *   verificationLink: 'https://acme.com/auth/verify?token=abc',
 *   expiryMinutes: 1440,
 * });
 * await mailer.send({ to: userEmail, ...rendered });
 */
export function renderTemplate(template: EmailTemplate, vars: TemplateVariables): EmailTemplate {
  const replace = (str: string, escape: boolean): string =>
    str.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
      if (!(key in vars)) return match;
      const strValue = String(vars[key]);
      return escape ? escapeHtml(strValue) : strValue;
    });

  return {
    subject: replace(template.subject, false),
    html: replace(template.html, true),
    ...(template.text !== undefined ? { text: replace(template.text, false) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Shared HTML shell
// ---------------------------------------------------------------------------

function htmlShell(bodyContent: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Email</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
          <tr>
            <td style="padding:40px 48px;">
              ${bodyContent}
            </td>
          </tr>
          <tr>
            <td style="padding:24px 48px;background-color:#f9fafb;border-top:1px solid #e5e7eb;">
              <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">
                This email was sent by {{appName}}. If you did not request this, you can safely ignore it.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function ctaButton(href: string, label: string): string {
  return `<a href="${href}" style="display:inline-block;padding:12px 24px;background-color:#18181b;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;letter-spacing:0.01em;">${label}</a>`;
}

function heading(text: string): string {
  return `<h1 style="margin:0 0 8px 0;font-size:22px;font-weight:700;color:#111827;line-height:1.3;">${text}</h1>`;
}

function subtext(text: string): string {
  return `<p style="margin:0 0 24px 0;font-size:14px;color:#6b7280;line-height:1.6;">${text}</p>`;
}

function appNameHeading(): string {
  return `<p style="margin:0 0 24px 0;font-size:13px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;">{{appName}}</p>`;
}

function linkFallback(href: string): string {
  return `<p style="margin:24px 0 0 0;font-size:12px;color:#9ca3af;">If the button doesn't work, copy and paste this link:<br /><a href="${href}" style="color:#6b7280;word-break:break-all;">${href}</a></p>`;
}

// ---------------------------------------------------------------------------
// Built-in templates
// ---------------------------------------------------------------------------

/**
 * Built-in auth email templates keyed by name.
 *
 * Available templates and their required variables:
 * - `emailVerification` — `{{appName}}`, `{{verificationLink}}`, `{{expiryMinutes}}`
 * - `passwordReset` — `{{appName}}`, `{{resetLink}}`, `{{expiryMinutes}}`
 * - `magicLink` — `{{appName}}`, `{{magicLink}}`, `{{expiryMinutes}}`
 * - `emailOtp` — `{{appName}}`, `{{code}}`, `{{expiryMinutes}}`
 * - `welcomeEmail` — `{{appName}}`, `{{identifier}}`
 * - `accountDeletion` — `{{appName}}`, `{{cancelLink}}`, `{{gracePeriodHours}}`
 * - `orgInvitation` — `{{appName}}`, `{{orgName}}`, `{{invitationLink}}`, `{{expiryDays}}`
 *
 * All templates use inline CSS only — no external CDN dependencies.
 * Override individual templates via `AuthPluginConfig.emailTemplates`.
 *
 * @example
 * import { templates, renderTemplate } from '@lastshotlabs/slingshot-auth';
 *
 * const { subject, html, text } = renderTemplate(templates.passwordReset, {
 *   appName: 'Acme',
 *   resetLink: 'https://acme.com/auth/reset-password?token=xyz',
 *   expiryMinutes: 60,
 * });
 */
export const templates: Record<string, EmailTemplate> = {
  /**
   * Email verification
   * Variables: {{appName}}, {{verificationLink}}, {{expiryMinutes}}
   */
  emailVerification: {
    subject: 'Verify your email',
    html: htmlShell(`
              ${appNameHeading()}
              ${heading('Verify your email address')}
              ${subtext('Click the button below to verify your email address. This link expires in {{expiryMinutes}} minutes.')}
              ${ctaButton('{{verificationLink}}', 'Verify Email')}
              ${linkFallback('{{verificationLink}}')}
    `),
    text: `Verify your email address

Hi,

Please verify your email address for {{appName}} by visiting the link below.

{{verificationLink}}

This link expires in {{expiryMinutes}} minutes.

If you did not create an account, you can safely ignore this email.`,
  },

  /**
   * Password reset
   * Variables: {{appName}}, {{resetLink}}, {{expiryMinutes}}
   */
  passwordReset: {
    subject: 'Reset your password',
    html: htmlShell(`
              ${appNameHeading()}
              ${heading('Reset your password')}
              ${subtext('We received a request to reset your password. Click the button below to choose a new one. This link expires in {{expiryMinutes}} minutes.')}
              ${ctaButton('{{resetLink}}', 'Reset Password')}
              ${linkFallback('{{resetLink}}')}
    `),
    text: `Reset your password

Hi,

We received a request to reset your password for {{appName}}.

Visit the link below to choose a new password:

{{resetLink}}

This link expires in {{expiryMinutes}} minutes.

If you did not request a password reset, you can safely ignore this email.`,
  },

  /**
   * Magic link sign-in
   * Variables: {{appName}}, {{magicLink}}, {{expiryMinutes}}
   */
  magicLink: {
    subject: 'Your sign-in link',
    html: htmlShell(`
              ${appNameHeading()}
              ${heading('Your sign-in link')}
              ${subtext('Click the button below to sign in to {{appName}}. This link expires in {{expiryMinutes}} minutes and can only be used once.')}
              ${ctaButton('{{magicLink}}', 'Sign In')}
              ${linkFallback('{{magicLink}}')}
    `),
    text: `Your sign-in link for {{appName}}

Hi,

Use the link below to sign in to {{appName}}. This link expires in {{expiryMinutes}} minutes and can only be used once.

{{magicLink}}

If you did not request this, you can safely ignore this email.`,
  },

  /**
   * Email OTP (MFA)
   * Variables: {{appName}}, {{code}}, {{expiryMinutes}}
   */
  emailOtp: {
    subject: 'Your verification code',
    html: htmlShell(`
              ${appNameHeading()}
              ${heading('Your verification code')}
              ${subtext('Enter the code below to complete your sign-in. It expires in {{expiryMinutes}} minutes.')}
              <div style="margin:0 0 24px 0;padding:20px;background-color:#f9fafb;border-radius:6px;text-align:center;border:1px solid #e5e7eb;">
                <span style="font-size:36px;font-weight:700;color:#111827;letter-spacing:0.15em;font-family:'Courier New',Courier,monospace;">{{code}}</span>
              </div>
              <p style="margin:0;font-size:13px;color:#9ca3af;">Do not share this code with anyone. {{appName}} will never ask for your code.</p>
    `),
    text: `Your verification code for {{appName}}

Your verification code is:

{{code}}

This code expires in {{expiryMinutes}} minutes. Do not share it with anyone.

If you did not request this, you can safely ignore this email.`,
  },

  /**
   * Welcome email (sent after registration)
   * Variables: {{appName}}, {{identifier}}
   */
  welcomeEmail: {
    subject: 'Welcome to {{appName}}',
    html: htmlShell(`
              ${appNameHeading()}
              ${heading('Welcome to {{appName}}')}
              ${subtext("Your account has been created for <strong>{{identifier}}</strong>. You're all set to get started.")}
              <p style="margin:0;font-size:14px;color:#6b7280;line-height:1.6;">If you have any questions, don't hesitate to reach out to our support team.</p>
    `),
    text: `Welcome to {{appName}}

Hi {{identifier}},

Your account has been created. You're all set to get started.

If you have any questions, don't hesitate to reach out to our support team.

— The {{appName}} Team`,
  },

  /**
   * Account deletion scheduled (with cancel link)
   * Variables: {{appName}}, {{cancelLink}}, {{gracePeriodHours}}
   */
  accountDeletion: {
    subject: 'Account deletion scheduled',
    html: htmlShell(`
              ${appNameHeading()}
              ${heading('Your account is scheduled for deletion')}
              ${subtext('Your {{appName}} account has been scheduled for deletion. If this was a mistake, click the button below to cancel within {{gracePeriodHours}} hours.')}
              ${ctaButton('{{cancelLink}}', 'Cancel Deletion')}
              ${linkFallback('{{cancelLink}}')}
              <p style="margin:24px 0 0 0;font-size:13px;color:#ef4444;font-weight:500;">After {{gracePeriodHours}} hours, your account and all associated data will be permanently deleted and cannot be recovered.</p>
    `),
    text: `Your account is scheduled for deletion

Hi,

Your {{appName}} account has been scheduled for deletion. If this was a mistake, visit the link below to cancel within {{gracePeriodHours}} hours.

{{cancelLink}}

After {{gracePeriodHours}} hours, your account and all associated data will be permanently deleted and cannot be recovered.

If you intended to delete your account, no action is needed.`,
  },

  /**
   * Organization invitation
   * Variables: {{appName}}, {{orgName}}, {{invitationLink}}, {{expiryDays}}
   */
  orgInvitation: {
    subject: "You've been invited to join {{orgName}}",
    html: htmlShell(`
              ${appNameHeading()}
              ${heading("You've been invited to join {{orgName}}")}
              ${subtext("You've been invited to join <strong>{{orgName}}</strong> on {{appName}}. Click the button below to accept your invitation. This invite expires in {{expiryDays}} days.")}
              ${ctaButton('{{invitationLink}}', 'Accept Invitation')}
              ${linkFallback('{{invitationLink}}')}
    `),
    text: `You've been invited to join {{orgName}}

Hi,

You've been invited to join {{orgName}} on {{appName}}.

Accept your invitation here:

{{invitationLink}}

This invite expires in {{expiryDays}} days.

If you were not expecting this invitation, you can safely ignore this email.`,
  },
};
