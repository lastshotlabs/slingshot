import { describe, expect, it } from 'bun:test';
import { resolveAndInterpolateSubject, resolveSubject } from '../../src/lib/subjectResolution.js';

describe('resolveSubject', () => {
  it('uses subscriptionSubject when provided', () => {
    expect(resolveSubject('From Sub', 'From Renderer', '(fallback)')).toBe('From Sub');
  });

  it('falls back to rendererSubject when subscriptionSubject is undefined', () => {
    expect(resolveSubject(undefined, 'From Renderer', '(fallback)')).toBe('From Renderer');
  });

  it('falls back to default when both are undefined', () => {
    expect(resolveSubject(undefined, undefined, '(fallback)')).toBe('(fallback)');
  });

  it('uses built-in fallback "(no subject)" when no fallback is provided', () => {
    expect(resolveSubject(undefined, undefined)).toBe('(no subject)');
  });
});

describe('resolveAndInterpolateSubject', () => {
  it('interpolates variables in the resolved subject', () => {
    const result = resolveAndInterpolateSubject('Reset password for {{appName}}', undefined, {
      appName: 'Slingshot',
    });
    expect(result).toBe('Reset password for Slingshot');
  });

  it('interpolates renderer subject when subscription subject is not set', () => {
    const result = resolveAndInterpolateSubject(undefined, 'Welcome to {{appName}}', {
      appName: 'MyApp',
    });
    expect(result).toBe('Welcome to MyApp');
  });

  it('interpolates the fallback subject (which has no variables)', () => {
    const result = resolveAndInterpolateSubject(undefined, undefined, {});
    expect(result).toBe('(no subject)');
  });

  it('leaves unknown variables as empty string', () => {
    const result = resolveAndInterpolateSubject('Hello {{name}}', undefined, {});
    expect(result).toBe('Hello ');
  });

  it('subscription subject wins over renderer subject in interpolation', () => {
    const result = resolveAndInterpolateSubject('Sub: {{x}}', 'Renderer: {{x}}', { x: 'value' });
    expect(result).toBe('Sub: value');
  });
});
