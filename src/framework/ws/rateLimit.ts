import type { WsRateLimitBucket, WsState } from '@lastshotlabs/slingshot-core';
import type { WsRateLimitConfig } from '../../config/types/ws';

export function checkRateLimit(
  state: WsState,
  endpoint: string,
  socketId: string,
  config: WsRateLimitConfig,
): 'allow' | 'drop' | 'close' {
  const now = Date.now();
  let endpointBuckets = state.rateLimitState.get(endpoint);
  if (!endpointBuckets) {
    endpointBuckets = new Map<string, WsRateLimitBucket>();
    state.rateLimitState.set(endpoint, endpointBuckets);
  }

  let bucket = endpointBuckets.get(socketId);
  if (!bucket || now - bucket.windowStart >= config.windowMs) {
    bucket = { count: 0, windowStart: now };
    endpointBuckets.set(socketId, bucket);
  }

  bucket.count++;
  if (bucket.count > config.maxMessages) {
    return config.onExceeded === 'close' ? 'close' : 'drop';
  }
  return 'allow';
}

export function cleanupRateLimitBucket(state: WsState, endpoint: string, socketId: string): void {
  state.rateLimitState.get(endpoint)?.delete(socketId);
}
