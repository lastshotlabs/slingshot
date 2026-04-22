import { verifyCaptcha } from '@framework/lib/captcha';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv, CaptchaConfig } from '@lastshotlabs/slingshot-core';
import { HttpError, getContextOrNull } from '@lastshotlabs/slingshot-core';
import { getClientIp } from '@lastshotlabs/slingshot-core';

/**
 * Middleware factory that verifies a CAPTCHA token from the request body.
 *
 * When no `config` is provided, falls back to the captcha configuration
 * from the app's {@link SlingshotContext}. If neither is available, the
 * middleware is a no-op (passes through to the next handler).
 *
 * @param config - Optional CAPTCHA provider configuration. When omitted,
 *   uses the app-level captcha config from context.
 * @returns A Hono middleware that extracts and verifies the CAPTCHA token.
 * @throws {HttpError} `400 CAPTCHA_MISSING` when the token field is absent.
 * @throws {HttpError} `400 CAPTCHA_FAILED` when provider verification fails.
 *
 * @example
 * ```ts
 * router.post("/contact", requireCaptcha({ provider: "turnstile", secretKey: "..." }), handler);
 * ```
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
