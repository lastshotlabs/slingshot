import { describe, expect, mock, test } from 'bun:test';
import { runtimeNodeInternals } from '../../src/index';

const {
  toBufferChunk,
  stringifyWsPayload,
  resolveListenPort,
  resolveNodeRequestListener,
  attachNodeRequestListener,
  deleteChannelIfEmpty,
} = runtimeNodeInternals;

// ---------------------------------------------------------------------------
// toBufferChunk
// ---------------------------------------------------------------------------

describe('toBufferChunk', () => {
  test('returns a Buffer from a string', () => {
    const result = toBufferChunk('hello');
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result?.toString()).toBe('hello');
  });

  test('returns the same Buffer when given a Buffer', () => {
    const buf = Buffer.from('world');
    const result = toBufferChunk(buf);
    expect(result).toBe(buf);
  });

  test('returns a Buffer from an ArrayBuffer', () => {
    const ab = new TextEncoder().encode('abc').buffer;
    const result = toBufferChunk(ab);
    expect(result?.toString()).toBe('abc');
  });

  test('returns a Buffer from a typed array view (Uint8Array)', () => {
    const view = new Uint8Array([104, 105]); // 'hi'
    const result = toBufferChunk(view);
    expect(result?.toString()).toBe('hi');
  });

  test('returns null for an unrecognized type', () => {
    expect(toBufferChunk(42)).toBeNull();
    expect(toBufferChunk(null)).toBeNull();
    expect(toBufferChunk({})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// stringifyWsPayload
// ---------------------------------------------------------------------------

describe('stringifyWsPayload', () => {
  test('returns a string unchanged', () => {
    expect(stringifyWsPayload('hello')).toBe('hello');
  });

  test('converts a Buffer to its string contents', () => {
    expect(stringifyWsPayload(Buffer.from('world'))).toBe('world');
  });

  test('converts an ArrayBuffer to a string', () => {
    const ab = new TextEncoder().encode('ok').buffer;
    expect(stringifyWsPayload(ab)).toBe('ok');
  });

  test('concatenates an array of Buffer chunks', () => {
    const chunks = [Buffer.from('foo'), Buffer.from('bar')];
    expect(stringifyWsPayload(chunks)).toBe('foobar');
  });

  test('concatenates an array of string chunks treated as buffers', () => {
    const chunks = [Buffer.from('a'), Buffer.from('b'), Buffer.from('c')];
    expect(stringifyWsPayload(chunks)).toBe('abc');
  });

  test('throws TypeError for an array containing an unrecognized chunk type', () => {
    expect(() => stringifyWsPayload([42])).toThrow(TypeError);
  });

  test('throws TypeError for a completely unrecognized payload type', () => {
    expect(() => stringifyWsPayload({ unexpected: true })).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// resolveListenPort
// ---------------------------------------------------------------------------

describe('resolveListenPort', () => {
  test('returns the provided port', () => {
    expect(resolveListenPort(8080)).toBe(8080);
  });

  test('returns 3000 when port is undefined', () => {
    expect(resolveListenPort(undefined)).toBe(3000);
  });
});

// ---------------------------------------------------------------------------
// resolveNodeRequestListener
// ---------------------------------------------------------------------------

describe('resolveNodeRequestListener', () => {
  test('returns the second argument when it is a function', () => {
    const fn1 = () => {};
    const fn2 = () => {};
    expect(resolveNodeRequestListener(fn1, fn2)).toBe(fn2);
  });

  test('returns the first argument when only the first is a function', () => {
    const fn = () => {};
    expect(resolveNodeRequestListener(fn, undefined)).toBe(fn);
  });

  test('returns null when neither argument is a function', () => {
    expect(resolveNodeRequestListener({}, {})).toBeNull();
  });

  test('returns null when both arguments are undefined', () => {
    expect(resolveNodeRequestListener(undefined, undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// attachNodeRequestListener
// ---------------------------------------------------------------------------

describe('attachNodeRequestListener', () => {
  test('registers the second arg as a request listener when it is a function', () => {
    const calls: unknown[] = [];
    const server = { on: (event: string, listener: unknown) => calls.push({ event, listener }) };
    const fn1 = () => {};
    const fn2 = () => {};
    attachNodeRequestListener(server, fn1, fn2);
    expect(calls).toHaveLength(1);
    expect((calls[0] as { event: string; listener: unknown }).event).toBe('request');
    expect((calls[0] as { event: string; listener: unknown }).listener).toBe(fn2);
  });

  test('registers the first arg when only the first is a function', () => {
    const calls: unknown[] = [];
    const server = { on: (event: string, listener: unknown) => calls.push({ event, listener }) };
    const fn = () => {};
    attachNodeRequestListener(server, fn);
    expect(calls).toHaveLength(1);
    expect((calls[0] as { listener: unknown }).listener).toBe(fn);
  });

  test('does not call server.on() when neither arg is a function', () => {
    const onSpy = mock(() => {});
    const server = { on: onSpy };
    attachNodeRequestListener(server, {});
    expect(onSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// deleteChannelIfEmpty
// ---------------------------------------------------------------------------

describe('deleteChannelIfEmpty', () => {
  test('deletes the channel when its set is empty', () => {
    const channels = new Map([['events', new Set()]]);
    deleteChannelIfEmpty(channels, 'events', channels.get('events'));
    expect(channels.has('events')).toBe(false);
  });

  test('does not delete the channel when its set has subscribers', () => {
    const subs = new Set(['subscriber-1']);
    const channels = new Map([['events', subs]]);
    deleteChannelIfEmpty(channels, 'events', subs);
    expect(channels.has('events')).toBe(true);
  });

  test('is a no-op when subs is undefined', () => {
    const channels = new Map([['events', new Set()]]);
    deleteChannelIfEmpty(channels, 'events', undefined);
    expect(channels.has('events')).toBe(true);
  });
});
