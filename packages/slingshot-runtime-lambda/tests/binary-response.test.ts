import { describe, expect, test } from 'bun:test';
import { encodeHttpBody, isBinaryBody, isBinaryContentType } from '../src/triggers/_httpResponse';
import { albTrigger } from '../src/triggers/alb';
import { apigwTrigger } from '../src/triggers/apigw';
import { apigwV2Trigger } from '../src/triggers/apigw-v2';

describe('encodeHttpBody', () => {
  test('Buffer body is base64-encoded with isBase64Encoded:true', () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG header bytes
    const result = encodeHttpBody(buf, { contentType: 'image/png' });
    expect(result.isBase64Encoded).toBe(true);
    expect(result.body).toBe(buf.toString('base64'));
    expect(result.failed).toBe(false);
  });

  test('Uint8Array body is base64-encoded', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const result = encodeHttpBody(bytes);
    expect(result.isBase64Encoded).toBe(true);
    expect(result.body).toBe(Buffer.from(bytes).toString('base64'));
  });

  test('ArrayBuffer body is base64-encoded', () => {
    const ab = new ArrayBuffer(4);
    new DataView(ab).setUint32(0, 0xdeadbeef);
    const result = encodeHttpBody(ab);
    expect(result.isBase64Encoded).toBe(true);
    expect(Buffer.from(result.body, 'base64').readUInt32BE(0)).toBe(0xdeadbeef);
  });

  test('plain object body is JSON-stringified with isBase64Encoded:false', () => {
    const result = encodeHttpBody({ ok: true, n: 7 });
    expect(result.isBase64Encoded).toBe(false);
    expect(result.body).toBe(JSON.stringify({ ok: true, n: 7 }));
  });

  test('plain string body without binary content-type is JSON-stringified', () => {
    // safeStringify treats strings as JSON values — they get re-quoted.
    const result = encodeHttpBody('hello');
    expect(result.isBase64Encoded).toBe(false);
    expect(result.body).toBe(JSON.stringify('hello'));
  });

  test('string body with binary content-type passes through as base64', () => {
    // Caller is asserting the string is already base64-encoded.
    const alreadyBase64 = Buffer.from('binary').toString('base64');
    const result = encodeHttpBody(alreadyBase64, { contentType: 'application/pdf' });
    expect(result.isBase64Encoded).toBe(true);
    expect(result.body).toBe(alreadyBase64);
  });

  test('oversized binary body returns 500 error', () => {
    const big = Buffer.alloc(2 * 1024 * 1024); // 2 MB > default 1 MB cap
    const result = encodeHttpBody(big);
    expect(result.failed).toBe(true);
    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body)).toEqual({
      error: 'Response too large',
      code: 'response-too-large',
    });
  });
});

describe('isBinaryBody', () => {
  test('returns true for Buffer, Uint8Array, ArrayBuffer, and DataView', () => {
    expect(isBinaryBody(Buffer.from('x'))).toBe(true);
    expect(isBinaryBody(new Uint8Array(1))).toBe(true);
    expect(isBinaryBody(new ArrayBuffer(1))).toBe(true);
    expect(isBinaryBody(new DataView(new ArrayBuffer(1)))).toBe(true);
  });

  test('returns false for strings, objects, null, undefined', () => {
    expect(isBinaryBody('hi')).toBe(false);
    expect(isBinaryBody({})).toBe(false);
    expect(isBinaryBody(null)).toBe(false);
    expect(isBinaryBody(undefined)).toBe(false);
  });
});

describe('isBinaryContentType', () => {
  const cases: Array<[string | undefined | null, boolean]> = [
    ['image/png', true],
    ['image/jpeg; charset=binary', true],
    ['audio/mpeg', true],
    ['video/mp4', true],
    ['application/octet-stream', true],
    ['application/pdf', true],
    ['APPLICATION/PDF', true],
    ['application/json', false],
    ['text/plain', false],
    ['', false],
    [undefined, false],
    [null, false],
  ];
  for (const [input, expected] of cases) {
    test(`isBinaryContentType(${JSON.stringify(input)}) === ${expected}`, () => {
      expect(isBinaryContentType(input)).toBe(expected);
    });
  }
});

describe('HTTP trigger binary response wiring', () => {
  test('apigwTrigger returns isBase64Encoded:true for Buffer output', () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff]); // JPEG header
    const result = apigwTrigger.assembleResult([
      {
        meta: { http: { status: 200, headers: { 'content-type': 'image/jpeg' } } },
        result: 'success',
        output: buf,
      },
    ]) as { isBase64Encoded: boolean; body: string; headers: Record<string, string> };
    expect(result.isBase64Encoded).toBe(true);
    expect(result.body).toBe(buf.toString('base64'));
    expect(result.headers['content-type']).toBe('image/jpeg');
  });

  test('apigwTrigger returns isBase64Encoded:false for plain JSON output', () => {
    const result = apigwTrigger.assembleResult([
      {
        meta: { http: { status: 200 } },
        result: 'success',
        output: { ok: true },
      },
    ]) as { isBase64Encoded: boolean; body: string };
    expect(result.isBase64Encoded).toBe(false);
    expect(result.body).toBe(JSON.stringify({ ok: true }));
  });

  test('apigwV2Trigger handles Uint8Array output', () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
    const result = apigwV2Trigger.assembleResult([
      {
        meta: { http: { status: 200, headers: { 'content-type': 'application/pdf' } } },
        result: 'success',
        output: bytes,
      },
    ]) as { isBase64Encoded: boolean; body: string };
    expect(result.isBase64Encoded).toBe(true);
    expect(Buffer.from(result.body, 'base64').toString('ascii')).toBe('%PDF');
  });

  test('albTrigger returns isBase64Encoded:true for Buffer output and preserves status', () => {
    const buf = Buffer.from('octet-data');
    const result = albTrigger.assembleResult([
      {
        meta: {
          http: { status: 200, headers: { 'content-type': 'application/octet-stream' } },
        },
        result: 'success',
        output: buf,
      },
    ]) as {
      isBase64Encoded: boolean;
      body: string;
      statusCode: number;
      statusDescription: string;
      headers: Record<string, string>;
    };
    expect(result.isBase64Encoded).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.statusDescription).toBe('200 OK');
    expect(result.headers['content-type']).toBe('application/octet-stream');
  });

  test('albTrigger returns isBase64Encoded:false for string body without binary content-type', () => {
    const result = albTrigger.assembleResult([
      {
        meta: { http: { status: 200 } },
        result: 'success',
        output: { hello: 'world' },
      },
    ]) as { isBase64Encoded: boolean };
    expect(result.isBase64Encoded).toBe(false);
  });
});
