/**
 * Tests for buildAppleAasaBody and serializeAppleAasaBody.
 */
import { describe, expect, test } from 'bun:test';
import { buildAppleAasaBody, serializeAppleAasaBody } from '../src/aasa';
import type { AppleAppLink } from '../src/config';

const singleApp: AppleAppLink = {
  teamId: 'TEAM123456',
  bundleId: 'com.example.app',
  paths: ['/share/*', '/posts/*'],
};

const twoApps: AppleAppLink[] = [
  { teamId: 'TEAM123456', bundleId: 'com.example.app', paths: ['/share/*'] },
  { teamId: 'TEAM123456', bundleId: 'com.example.clips', paths: ['/clip/*'] },
];

describe('buildAppleAasaBody — structure', () => {
  test('returns null when apple is undefined', () => {
    expect(buildAppleAasaBody(undefined)).toBeNull();
  });

  test('returns null when apple is empty array', () => {
    expect(buildAppleAasaBody([])).toBeNull();
  });

  test('builds correct AASA shape for single app', () => {
    const body = buildAppleAasaBody([singleApp]);
    expect(body).not.toBeNull();
    expect(body!.applinks.apps).toEqual([]);
    expect(body!.applinks.details).toHaveLength(1);
    expect(body!.applinks.details[0]!.appID).toBe('TEAM123456.com.example.app');
    expect(body!.applinks.details[0]!.paths).toEqual(['/share/*', '/posts/*']);
  });

  test('builds correct AASA shape for multiple bundles', () => {
    const body = buildAppleAasaBody(twoApps);
    expect(body!.applinks.details).toHaveLength(2);
    expect(body!.applinks.details[0]!.appID).toBe('TEAM123456.com.example.app');
    expect(body!.applinks.details[1]!.appID).toBe('TEAM123456.com.example.clips');
  });

  test('always sets apps: [] (required by Apple)', () => {
    const body = buildAppleAasaBody([singleApp]);
    expect(body!.applinks.apps).toEqual([]);
  });

  test('appID format is teamId.bundleId', () => {
    const body = buildAppleAasaBody([
      { teamId: 'ABCDEF1234', bundleId: 'org.company.ios', paths: ['/'] },
    ]);
    expect(body!.applinks.details[0]!.appID).toBe('ABCDEF1234.org.company.ios');
  });
});

describe('serializeAppleAasaBody', () => {
  test('returns null when apple is undefined', () => {
    expect(serializeAppleAasaBody(undefined)).toBeNull();
  });

  test('returns valid JSON string', () => {
    const json = serializeAppleAasaBody([singleApp]);
    expect(json).not.toBeNull();
    const parsed = JSON.parse(json!) as { applinks: { apps: unknown[]; details: unknown[] } };
    expect(parsed.applinks).toBeDefined();
    expect(Array.isArray(parsed.applinks.apps)).toBe(true);
  });

  test('serialized JSON matches buildAppleAasaBody output', () => {
    const body = buildAppleAasaBody([singleApp]);
    const json = serializeAppleAasaBody([singleApp]);
    expect(json).toBe(JSON.stringify(body));
  });
});
