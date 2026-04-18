import { describe, expect, test } from 'bun:test';
import { resolveMongoMode } from '../../src/framework/dbDefaults';

describe('resolveMongoMode', () => {
  const cases: Array<
    [string, Parameters<typeof resolveMongoMode>[0], ReturnType<typeof resolveMongoMode>]
  > = [
    ['legacy empty db config keeps mongo single as the default', {}, 'single'],
    ['explicit mongo single wins', { mongo: 'single' }, 'single'],
    ['explicit mongo separate wins', { mongo: 'separate' }, 'separate'],
    ['explicit mongo false wins', { mongo: false }, false],
    ['sqlite-only apps do not implicitly require mongo', { sqlite: ':memory:' }, false],
    ['postgres-only apps do not implicitly require mongo', { postgres: 'postgres://db' }, false],
    [
      'sqlite plus postgres does not implicitly require mongo',
      { sqlite: ':memory:', postgres: 'postgres://db' },
      false,
    ],
    ['memory auth disables implicit mongo', { auth: 'memory' }, false],
    ['sqlite auth disables implicit mongo', { auth: 'sqlite' }, false],
    ['postgres auth disables implicit mongo', { auth: 'postgres' }, false],
    ['explicit mongo auth requires mongo', { auth: 'mongo' }, 'single'],
    ['mongo sessions require mongo', { sessions: 'mongo' }, 'single'],
    ['mongo oauth state requires mongo', { oauthState: 'mongo' }, 'single'],
    ['mongo cache requires mongo', { cache: 'mongo' }, 'single'],
    [
      'sqlite can still explicitly opt into mongo auth',
      { sqlite: ':memory:', auth: 'mongo' },
      'single',
    ],
    [
      'postgres can still explicitly opt into mongo cache',
      { postgres: 'postgres://db', cache: 'mongo' },
      'single',
    ],
  ];

  test.each(cases)('%s', (_label, db, expected) => {
    expect(resolveMongoMode(db)).toBe(expected);
  });
});
