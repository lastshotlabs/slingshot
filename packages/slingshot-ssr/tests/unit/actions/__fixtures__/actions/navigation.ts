import { ActionRedirect } from '../../../../../src/actions/routes';

export async function ok(): Promise<{ ok: true }> {
  return { ok: true };
}

export async function externalRedirect(): Promise<never> {
  throw new ActionRedirect('https://evil.example.com/phish');
}

export async function fail(): Promise<never> {
  throw new Error('secret action failure');
}
