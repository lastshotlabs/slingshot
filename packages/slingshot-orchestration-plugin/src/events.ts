import type { OrchestrationEventMap } from '@lastshotlabs/slingshot-orchestration';

declare module '@lastshotlabs/slingshot-core' {
  // This augmentation intentionally inherits the full orchestration event map.
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface SlingshotEventMap extends OrchestrationEventMap {}
}

export {};
