// Types re-exported from core — canonical definitions live in @lastshotlabs/slingshot-core
import type { CaptchaConfig, CaptchaProvider } from '@lastshotlabs/slingshot-core';

export type { CaptchaProvider, CaptchaConfig } from '@lastshotlabs/slingshot-core';

const VERIFY_URLS: Record<CaptchaProvider, string> = {
  recaptcha: 'https://www.google.com/recaptcha/api/siteverify',
  hcaptcha: 'https://hcaptcha.com/siteverify',
  turnstile: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
};

/**
 * Verify a CAPTCHA token with the provider's API.
 * Returns { success: true } on pass, { success: false, error } on fail.
 */
export async function verifyCaptcha(
  token: string,
  config: CaptchaConfig,
  ip?: string,
): Promise<{ success: boolean; score?: number; error?: string }> {
  const url = VERIFY_URLS[config.provider];

  const body = new URLSearchParams({ secret: config.secretKey, response: token });
  if (ip) body.set('remoteip', ip);

  let data: Record<string, unknown>;
  try {
    const res = await fetch(url, { method: 'POST', body });
    if (!res.ok) return { success: false, error: `Provider returned ${res.status}` };
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    return { success: false, error: 'CAPTCHA provider unreachable' };
  }

  if (!data.success) {
    return {
      success: false,
      error: (data['error-codes'] as string[] | undefined)?.[0] ?? 'invalid-token',
    };
  }

  // reCAPTCHA v3: check score
  if (config.provider === 'recaptcha' && typeof data.score === 'number') {
    const minScore = config.minScore ?? 0.5;
    if (data.score < minScore) {
      return { success: false, score: data.score, error: 'score-too-low' };
    }
    return { success: true, score: data.score };
  }

  return { success: true };
}
