import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createConsoleLogger, noopLogger } from '../../src/observability/logger';

interface Captured {
  method: 'debug' | 'info' | 'warn' | 'error';
  line: string;
}

function captureConsole(): { lines: Captured[]; restore: () => void } {
  const lines: Captured[] = [];
  const debugSpy = spyOn(console, 'debug').mockImplementation((...args: unknown[]) => {
    lines.push({ method: 'debug', line: String(args[0]) });
  });
  const infoSpy = spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
    lines.push({ method: 'info', line: String(args[0]) });
  });
  const warnSpy = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    lines.push({ method: 'warn', line: String(args[0]) });
  });
  const errorSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push({ method: 'error', line: String(args[0]) });
  });
  return {
    lines,
    restore: () => {
      debugSpy.mockRestore();
      infoSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    },
  };
}

describe('createConsoleLogger', () => {
  let captured: ReturnType<typeof captureConsole>;
  beforeEach(() => {
    captured = captureConsole();
  });
  afterEach(() => {
    captured.restore();
  });

  test('emits one JSON line per call with msg, level, timestamp, and fields', () => {
    const log = createConsoleLogger({ level: 'debug' });
    log.info('hello', { requestId: 'req_1', count: 3 });
    expect(captured.lines).toHaveLength(1);
    const entry = captured.lines[0];
    expect(entry.method).toBe('info');
    const parsed = JSON.parse(entry.line);
    expect(parsed.level).toBe('info');
    expect(parsed.msg).toBe('hello');
    expect(typeof parsed.timestamp).toBe('string');
    expect(new Date(parsed.timestamp).toString()).not.toBe('Invalid Date');
    expect(parsed.requestId).toBe('req_1');
    expect(parsed.count).toBe(3);
  });

  test('suppresses debug records when level is info', () => {
    const log = createConsoleLogger({ level: 'info' });
    log.debug('quiet');
    log.info('loud');
    expect(captured.lines).toHaveLength(1);
    expect(JSON.parse(captured.lines[0].line).msg).toBe('loud');
  });

  test('child() merges base fields and call-site fields, with call-site winning', () => {
    const log = createConsoleLogger({ level: 'debug', base: { app: 'core' } });
    const sub = log.child({ requestId: 'req_2', app: 'override-loses' });
    sub.warn('warning', { app: 'call-site-wins', extra: true });
    expect(captured.lines).toHaveLength(1);
    const parsed = JSON.parse(captured.lines[0].line);
    expect(parsed.app).toBe('call-site-wins');
    expect(parsed.requestId).toBe('req_2');
    expect(parsed.extra).toBe(true);
    expect(parsed.level).toBe('warn');
  });

  test('routes each level to its matching console method', () => {
    const log = createConsoleLogger({ level: 'debug' });
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(captured.lines.map(l => l.method)).toEqual(['debug', 'info', 'warn', 'error']);
  });
});

describe('noopLogger', () => {
  test('does not emit to the console', () => {
    const captured = captureConsole();
    try {
      noopLogger.info('ignored');
      noopLogger.error('ignored');
      noopLogger.child({ x: 1 }).warn('ignored');
      expect(captured.lines).toHaveLength(0);
    } finally {
      captured.restore();
    }
  });
});
