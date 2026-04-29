import { describe, expect, mock, spyOn, test } from 'bun:test';
import { TIMEOUT_CLAMP_MS, clampDeliveryTimeoutMs } from '../../src/plugin.js';

describe('clampDeliveryTimeoutMs (P-WEBHOOKS-9)', () => {
  test('passes through values at or below 120s', () => {
    const bus = { emit: mock(() => {}) };
    expect(clampDeliveryTimeoutMs(30_000, { deliveryId: 'd', endpointId: 'e' }, bus)).toBe(30_000);
    expect(
      clampDeliveryTimeoutMs(TIMEOUT_CLAMP_MS, { deliveryId: 'd', endpointId: 'e' }, bus),
    ).toBe(TIMEOUT_CLAMP_MS);
    expect(bus.emit).not.toHaveBeenCalled();
  });

  test('clamps oversized values, logs warning, and emits webhook:timeoutClamped', () => {
    const bus = { emit: mock(() => {}) };
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const result = clampDeliveryTimeoutMs(200_000, { deliveryId: 'd1', endpointId: 'ep1' }, bus);
    expect(result).toBe(TIMEOUT_CLAMP_MS);
    expect(bus.emit).toHaveBeenCalledTimes(1);
    const [event, payload] = bus.emit.mock.calls[0] as unknown[] as [
      string,
      { requestedTimeoutMs: number; clampedTimeoutMs: number },
    ];
    expect(event).toBe('webhook:timeoutClamped');
    expect(payload.requestedTimeoutMs).toBe(200_000);
    expect(payload.clampedTimeoutMs).toBe(TIMEOUT_CLAMP_MS);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test('survives bus.emit throwing', () => {
    const bus = {
      emit: mock(() => {
        throw new Error('bus down');
      }),
    };
    spyOn(console, 'warn').mockImplementation(() => {});
    expect(() =>
      clampDeliveryTimeoutMs(200_000, { deliveryId: 'd', endpointId: 'e' }, bus),
    ).not.toThrow();
  });
});
