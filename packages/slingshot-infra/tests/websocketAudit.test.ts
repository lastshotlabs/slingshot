import { describe, expect, it } from 'bun:test';
import { auditWebsocketScaling } from '../src/config/websocketScalingAudit';

describe('auditWebsocketScaling', () => {
  it('returns no diagnostics when ws is absent', () => {
    const result = auditWebsocketScaling({});
    expect(result.diagnostics).toHaveLength(0);
  });

  it('returns no diagnostics when ws.endpoints is empty', () => {
    const result = auditWebsocketScaling({ ws: { endpoints: {} } });
    expect(result.diagnostics).toHaveLength(0);
  });

  it('emits ws:no-transport when endpoints exist but no transport', () => {
    const result = auditWebsocketScaling({
      ws: { endpoints: { chat: {} } },
    });
    const diag = result.diagnostics.find(d => d.id === 'ws:no-transport');
    expect(diag).toBeDefined();
    expect(diag!.severity).toBe('info');
    expect(diag!.message).toContain('1 WebSocket endpoint');
  });

  it('includes correct count for multiple endpoints', () => {
    const result = auditWebsocketScaling({
      ws: { endpoints: { chat: {}, notifications: {}, game: {} } },
    });
    const diag = result.diagnostics.find(d => d.id === 'ws:no-transport');
    expect(diag!.message).toContain('3 WebSocket endpoint');
  });

  it('emits ws:presence-no-transport when presence enabled without transport', () => {
    const result = auditWebsocketScaling({
      ws: {
        endpoints: {
          chat: { presence: true },
          notifications: {},
        },
      },
    });
    const diag = result.diagnostics.find(d => d.id === 'ws:presence-no-transport');
    expect(diag).toBeDefined();
    expect(diag!.severity).toBe('info');
    expect(diag!.message).toContain('chat');
    expect(diag!.message).not.toContain('notifications');
  });

  it('does not emit presence diagnostic when presence is false', () => {
    const result = auditWebsocketScaling({
      ws: { endpoints: { chat: { presence: false } } },
    });
    const diag = result.diagnostics.find(d => d.id === 'ws:presence-no-transport');
    expect(diag).toBeUndefined();
  });

  it('does not emit no-transport when transport is configured', () => {
    const result = auditWebsocketScaling({
      ws: { endpoints: { chat: {} }, transport: { type: 'redis' } },
    });
    const noTransport = result.diagnostics.find(d => d.id === 'ws:no-transport');
    expect(noTransport).toBeUndefined();
  });

  it('emits ws:memory-cache-multi-instance when transport + memory cache', () => {
    const result = auditWebsocketScaling({
      ws: { endpoints: { chat: {} }, transport: { type: 'redis' } },
      db: { cache: 'memory' },
    });
    const diag = result.diagnostics.find(d => d.id === 'ws:memory-cache-multi-instance');
    expect(diag).toBeDefined();
    expect(diag!.severity).toBe('warning');
  });

  it('does not emit memory-cache warning when cache is redis', () => {
    const result = auditWebsocketScaling({
      ws: { endpoints: { chat: {} }, transport: { type: 'redis' } },
      db: { cache: 'redis' },
    });
    const diag = result.diagnostics.find(d => d.id === 'ws:memory-cache-multi-instance');
    expect(diag).toBeUndefined();
  });

  it('emits ws:memory-sessions-multi-instance when transport + memory sessions', () => {
    const result = auditWebsocketScaling({
      ws: { endpoints: { chat: {} }, transport: { type: 'redis' } },
      db: { sessions: 'memory' },
    });
    const diag = result.diagnostics.find(d => d.id === 'ws:memory-sessions-multi-instance');
    expect(diag).toBeDefined();
    expect(diag!.severity).toBe('warning');
  });

  it('deep-freezes the result', () => {
    const result = auditWebsocketScaling({
      ws: { endpoints: { chat: {} } },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.diagnostics)).toBe(true);
    if (result.diagnostics.length > 0) {
      expect(Object.isFrozen(result.diagnostics[0])).toBe(true);
    }
  });
});
