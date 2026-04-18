import { verifyCaptcha } from '@framework/lib/captcha';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv, CaptchaConfig } from '@lastshotlabs/slingshot-core';
import { HttpError, getContextOrNull } from '@lastshotlabs/slingshot-core';
import { getClientIp } from '@lastshotlabs/slingshot-core';

/**
 * Middleware factory that verifies a CAPTCHA token from the request body.
 *
 * @example
 * router.post("/contact", requireCaptcha({ provider: "turnstile", secretKey: "..." }), handler);
 */
export const requireCaptcha =
  (config?: CaptchaConfig): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    // Get effective config: param takes precedence, then context config
    const slingshotCtx =
      typeof (c as { get?: unknown }).get === 'function'
        ? ((c as { get(key: string): unknown }).get('slingshotCtx') as { app?: object } | undefined)
        : undefined;
    const ctx = slingshotCtx?.app ? getContextOrNull(slingshotCtx.app) : null;
    const effectiveConfig = config ?? (ctx?.config.captcha as CaptchaConfig | null) ?? undefined;
    if (!effectiveConfig) {
      await next();
      return;
    }

    const tokenField = effectiveConfig.tokenField ?? 'captcha-token';
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }

    const token = body[tokenField] as string | undefined;
    if (!token) {
      throw new HttpError(400, 'CAPTCHA token is required', 'CAPTCHA_MISSING');
    }

    const rawIp = getClientIp(c);
    const ip = rawIp !== 'unknown' ? rawIp : undefined;
    const result = await verifyCaptcha(token, effectiveConfig, ip);

    if (!result.success) {
      throw new HttpError(400, 'CAPTCHA verification failed', 'CAPTCHA_FAILED');
    }

    await next();
  };
