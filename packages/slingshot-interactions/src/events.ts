declare module '@lastshotlabs/slingshot-core' {
  interface SlingshotEventMap {
    'interactions:event.dispatched': {
      userId: string;
      tenantId?: string | null;
      messageKind: string;
      messageId: string;
      actionId: string;
      status: string;
      latencyMs: number;
    };
    'interactions:event.failed': {
      userId: string;
      tenantId?: string | null;
      messageKind: string;
      messageId: string;
      actionId: string;
      status: string;
      latencyMs: number;
    };
  }
}

export {};
