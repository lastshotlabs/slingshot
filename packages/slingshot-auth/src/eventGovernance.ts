import type {
  EventPublishContext,
  SlingshotEventMap,
  SlingshotEvents,
} from '@lastshotlabs/slingshot-core';
import { defineEvent } from '@lastshotlabs/slingshot-core';

type AuthManagedEventKey =
  | 'auth:user.created'
  | 'auth:user.deleted'
  | 'auth:login'
  | 'auth:logout'
  | 'auth:email.verified'
  | 'auth:password.reset.requested'
  | 'auth:account.deletion.scheduled'
  | 'auth:mfa.enabled'
  | 'auth:mfa.disabled'
  | 'auth:delivery.email_verification'
  | 'auth:delivery.password_reset'
  | 'auth:delivery.magic_link'
  | 'auth:delivery.email_otp'
  | 'auth:delivery.account_deletion'
  | 'auth:delivery.welcome'
  | 'auth:delivery.org_invitation';

export function registerAuthEventDefinitions(events: SlingshotEvents): void {
  const register = <K extends AuthManagedEventKey>(
    key: K,
    definition: Omit<Parameters<typeof defineEvent<K>>[1], 'key'>,
  ): void => {
    if (events.get(key)) {
      return;
    }
    events.register(defineEvent(key, definition));
  };

  register('auth:user.created', {
    ownerPlugin: 'slingshot-auth',
    exposure: ['internal'],
    resolveScope(payload, ctx) {
      return {
        tenantId: payload.tenantId ?? ctx.tenantId ?? null,
        userId: payload.userId,
        actorId: ctx.actorId ?? payload.userId,
      };
    },
  });
  register('auth:user.deleted', {
    ownerPlugin: 'slingshot-auth',
    exposure: ['internal'],
    resolveScope(payload, ctx) {
      return {
        tenantId: payload.tenantId ?? ctx.tenantId ?? null,
        userId: payload.userId,
        actorId: ctx.actorId ?? payload.userId,
      };
    },
  });
  register('auth:login', {
    ownerPlugin: 'slingshot-auth',
    exposure: ['user-webhook'],
    resolveScope(payload, ctx) {
      return {
        tenantId: payload.tenantId ?? ctx.tenantId ?? null,
        userId: payload.userId,
        actorId: ctx.actorId ?? payload.userId,
      };
    },
  });
  register('auth:logout', {
    ownerPlugin: 'slingshot-auth',
    exposure: ['user-webhook'],
    resolveScope(payload, ctx) {
      return {
        tenantId: payload.userId ? (ctx.tenantId ?? null) : null,
        userId: payload.userId,
        actorId: ctx.actorId ?? payload.userId,
      };
    },
  });
  register('auth:email.verified', {
    ownerPlugin: 'slingshot-auth',
    exposure: ['user-webhook'],
    resolveScope(payload, ctx) {
      return {
        tenantId: ctx.tenantId ?? null,
        userId: payload.userId,
        actorId: ctx.actorId ?? payload.userId,
      };
    },
  });
  register('auth:password.reset.requested', {
    ownerPlugin: 'slingshot-auth',
    exposure: ['internal'],
    resolveScope(payload, ctx) {
      return {
        tenantId: ctx.tenantId ?? null,
        userId: payload.userId,
        actorId: ctx.actorId ?? payload.userId,
      };
    },
  });
  register('auth:account.deletion.scheduled', {
    ownerPlugin: 'slingshot-auth',
    exposure: ['internal'],
    resolveScope(payload, ctx) {
      return {
        tenantId: ctx.tenantId ?? null,
        userId: payload.userId,
        actorId: ctx.actorId ?? payload.userId,
      };
    },
  });
  register('auth:mfa.enabled', {
    ownerPlugin: 'slingshot-auth',
    exposure: ['user-webhook'],
    resolveScope(payload, ctx) {
      return {
        tenantId: ctx.tenantId ?? null,
        userId: payload.userId,
        actorId: ctx.actorId ?? payload.userId,
      };
    },
  });
  register('auth:mfa.disabled', {
    ownerPlugin: 'slingshot-auth',
    exposure: ['user-webhook'],
    resolveScope(payload, ctx) {
      return {
        tenantId: ctx.tenantId ?? null,
        userId: payload.userId,
        actorId: ctx.actorId ?? payload.userId,
      };
    },
  });

  for (const key of [
    'auth:delivery.email_verification',
    'auth:delivery.password_reset',
    'auth:delivery.magic_link',
    'auth:delivery.email_otp',
    'auth:delivery.account_deletion',
    'auth:delivery.welcome',
    'auth:delivery.org_invitation',
  ] as const) {
    register(key, {
      ownerPlugin: 'slingshot-auth',
      exposure: ['internal'],
      resolveScope() {
        return null;
      },
    });
  }
}

export function publishAuthEvent<K extends AuthManagedEventKey>(
  events: SlingshotEvents,
  key: K,
  payload: SlingshotEventMap[K],
  ctx?: EventPublishContext,
): void {
  events.publish(key, payload, ctx);
}
