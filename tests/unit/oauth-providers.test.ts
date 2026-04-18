import { createOAuthProviders, getConfiguredOAuthProviders } from '@auth/lib/oauth';
import type { OAuthProviderConfig } from '@auth/lib/oauth';
import { describe, expect, test } from 'bun:test';

// Type-level checks: verify all new provider config shapes are present in OAuthProviderConfig
type AssertExtends<T, _U extends T> = true;

// linkedin
type _LinkedInConfig = AssertExtends<
  OAuthProviderConfig['linkedin'],
  { clientId: string; clientSecret: string; redirectUri: string } | undefined
>;

// twitter (clientSecret is string | null for public clients)
type _TwitterConfig = AssertExtends<
  OAuthProviderConfig['twitter'],
  { clientId: string; clientSecret: string | null; redirectUri: string } | undefined
>;

// gitlab (baseUrl is optional — defaults to gitlab.com)
type _GitLabConfig = AssertExtends<
  OAuthProviderConfig['gitlab'],
  | { baseUrl?: string; clientId: string; clientSecret: string | null; redirectUri: string }
  | undefined
>;

// slack (redirectUri is string | null)
type _SlackConfig = AssertExtends<
  OAuthProviderConfig['slack'],
  { clientId: string; clientSecret: string; redirectUri: string | null } | undefined
>;

// bitbucket
type _BitbucketConfig = AssertExtends<
  OAuthProviderConfig['bitbucket'],
  { clientId: string; clientSecret: string; redirectUri: string } | undefined
>;

describe('OAuth provider config types', () => {
  test('OAuthProviderConfig accepts all new provider keys', () => {
    const config: OAuthProviderConfig = {
      linkedin: {
        clientId: 'li-id',
        clientSecret: 'li-secret',
        redirectUri: 'https://example.com/auth/linkedin/callback',
      },
      twitter: {
        clientId: 'tw-id',
        clientSecret: 'tw-secret',
        redirectUri: 'https://example.com/auth/twitter/callback',
      },
      gitlab: {
        clientId: 'gl-id',
        clientSecret: 'gl-secret',
        redirectUri: 'https://example.com/auth/gitlab/callback',
      },
      slack: {
        clientId: 'sl-id',
        clientSecret: 'sl-secret',
        redirectUri: 'https://example.com/auth/slack/callback',
      },
      bitbucket: {
        clientId: 'bb-id',
        clientSecret: 'bb-secret',
        redirectUri: 'https://example.com/auth/bitbucket/callback',
      },
    };
    // Just checking TypeScript is happy — all keys must be defined
    expect(config.linkedin?.clientId).toBe('li-id');
    expect(config.twitter?.clientId).toBe('tw-id');
    expect(config.gitlab?.clientId).toBe('gl-id');
    expect(config.slack?.clientId).toBe('sl-id');
    expect(config.bitbucket?.clientId).toBe('bb-id');
  });

  test('twitter config accepts null clientSecret (public client)', () => {
    const config: OAuthProviderConfig = {
      twitter: {
        clientId: 'tw-id',
        clientSecret: null,
        redirectUri: 'https://example.com/auth/twitter/callback',
      },
    };
    expect(config.twitter?.clientSecret).toBeNull();
  });

  test('gitlab config accepts optional baseUrl', () => {
    const withoutBase: OAuthProviderConfig = {
      gitlab: {
        clientId: 'gl-id',
        clientSecret: 'gl-secret',
        redirectUri: 'https://example.com/auth/gitlab/callback',
      },
    };
    const withBase: OAuthProviderConfig = {
      gitlab: {
        baseUrl: 'https://gitlab.mycompany.com',
        clientId: 'gl-id',
        clientSecret: 'gl-secret',
        redirectUri: 'https://example.com/auth/gitlab/callback',
      },
    };
    expect(withoutBase.gitlab?.baseUrl).toBeUndefined();
    expect(withBase.gitlab?.baseUrl).toBe('https://gitlab.mycompany.com');
  });

  test('slack config accepts null redirectUri', () => {
    const config: OAuthProviderConfig = {
      slack: { clientId: 'sl-id', clientSecret: 'sl-secret', redirectUri: null },
    };
    expect(config.slack?.redirectUri).toBeNull();
  });
});

describe('createOAuthProviders — new providers register in configured list', () => {
  test('getConfiguredOAuthProviders returns linkedin when configured', () => {
    const providers = createOAuthProviders({
      linkedin: {
        clientId: 'li-id',
        clientSecret: 'li-secret',
        redirectUri: 'https://example.com/cb',
      },
    });
    expect(getConfiguredOAuthProviders(providers)).toContain('linkedin');
  });

  test('getConfiguredOAuthProviders returns twitter when configured', () => {
    const providers = createOAuthProviders({
      twitter: {
        clientId: 'tw-id',
        clientSecret: 'tw-secret',
        redirectUri: 'https://example.com/cb',
      },
    });
    expect(getConfiguredOAuthProviders(providers)).toContain('twitter');
  });

  test('getConfiguredOAuthProviders returns gitlab when configured', () => {
    const providers = createOAuthProviders({
      gitlab: {
        clientId: 'gl-id',
        clientSecret: 'gl-secret',
        redirectUri: 'https://example.com/cb',
      },
    });
    expect(getConfiguredOAuthProviders(providers)).toContain('gitlab');
  });

  test('getConfiguredOAuthProviders returns slack when configured', () => {
    const providers = createOAuthProviders({
      slack: {
        clientId: 'sl-id',
        clientSecret: 'sl-secret',
        redirectUri: 'https://example.com/cb',
      },
    });
    expect(getConfiguredOAuthProviders(providers)).toContain('slack');
  });

  test('getConfiguredOAuthProviders returns bitbucket when configured', () => {
    const providers = createOAuthProviders({
      bitbucket: {
        clientId: 'bb-id',
        clientSecret: 'bb-secret',
        redirectUri: 'https://example.com/cb',
      },
    });
    expect(getConfiguredOAuthProviders(providers)).toContain('bitbucket');
  });
});
