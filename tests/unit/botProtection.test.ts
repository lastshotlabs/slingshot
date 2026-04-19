import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { setStandaloneTrustProxy } from '@lastshotlabs/slingshot-core';
import { botProtection } from '../../src/framework/middleware/botProtection';

function makeApp(blockList: string[]) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    setStandaloneTrustProxy(c.req.raw, 1);
    await next();
  });
  app.use(botProtection({ blockList }));
  app.get('/', c => c.json({ ok: true }));
  return app;
}

function req(ip: string) {
  return new Request('http://test.com/', {
    headers: { 'x-forwarded-for': `${ip}, 127.0.0.1` },
  });
}

describe('botProtection', () => {
  it('passes when blockList is empty', async () => {
    const app = makeApp([]);
    const res = await app.request(req('1.2.3.4'));
    expect(res.status).toBe(200);
  });

  it('blocks exact IPv4 entries', async () => {
    const app = makeApp(['1.2.3.4']);
    const res = await app.request(req('1.2.3.4'));
    expect(res.status).toBe(403);
  });

  it('blocks CIDR entries', async () => {
    const app = makeApp(['192.168.1.0/24']);
    expect((await app.request(req('192.168.1.100'))).status).toBe(403);
    expect((await app.request(req('192.168.2.1'))).status).toBe(200);
  });

  it('normalizes IPv4-mapped IPv6', async () => {
    const app = makeApp(['1.2.3.4']);
    const res = await app.request(req('::ffff:1.2.3.4'));
    expect(res.status).toBe(403);
  });

  it('supports IPv6 exact matches', async () => {
    const app = makeApp(['::1']);
    expect((await app.request(req('::1'))).status).toBe(403);
    expect((await app.request(req('::2'))).status).toBe(200);
  });

  it('passes when IP cannot be determined', async () => {
    const app = new Hono();
    app.use(botProtection({ blockList: ['1.2.3.4'] }));
    app.get('/', c => c.json({ ok: true }));
    const res = await app.request(new Request('http://test.com/'));
    expect(res.status).toBe(200);
  });

  it('throws at construction time for an IPv4 blockList entry with wrong number of octets', () => {
    // Exercises ipv4ToUint32 line 17: parts.length !== 4
    expect(() => botProtection({ blockList: ['1.2.3'] })).toThrow(/Invalid IPv4/);
  });

  it('throws at construction time for an IPv4 CIDR with an out-of-range octet', () => {
    // Exercises ipv4ToUint32 line 20: octet value > 255
    expect(() => botProtection({ blockList: ['999.0.0.0/8'] })).toThrow(/Invalid IPv4/);
  });
});
