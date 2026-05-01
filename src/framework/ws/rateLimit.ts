import type { WsRateLimitBucket, WsState } from '@lastshotlabs/slingshot-core';
import type { WsRateLimitConfig } from '../../config/types/ws';

export function checkRateLimit(
  state: WsState,
  endpoint: string,
  socketId: string,
  config: WsRateLimitConfig,
): 'allow' | 'drop' | 'close' {
  // Guard against misconfigured limits: 0 window or 0 max disables rate limiting
  if (config.windowMs <= 0 || config.maxMessages <= 0) return 'allow';

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
