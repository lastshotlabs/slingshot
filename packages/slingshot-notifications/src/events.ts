import type { NotificationCreatedEventPayload } from '@lastshotlabs/slingshot-core';

declare module '@lastshotlabs/slingshot-core' {
  interface SlingshotEventMap {
    'notifications:notification.created': NotificationCreatedEventPayload;
    'notifications:notification.updated': {
      id?: string;
      userId?: string;
      tenantId?: string | null;
      count?: number;
      changes?: Readonly<Record<string, unknown>>;
      [key: string]: unknown;
    };
    'notifications:notification.read': {
      id?: string;
      userId?: string;
      tenantId?: string | null;
      [key: string]: unknown;
    };
  }
}

export {};
