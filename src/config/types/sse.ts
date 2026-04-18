import type { SseEndpointConfig } from '@lastshotlabs/slingshot-core';

export interface SseConfig<T extends object = object> {
  endpoints: Record<string, SseEndpointConfig<T>>;
}
