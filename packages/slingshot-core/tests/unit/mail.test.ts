import { describe, expect, test } from 'bun:test';
import { TemplateNotFoundError } from '../../src/mail';

describe('TemplateNotFoundError', () => {
  test('sets message with template name', () => {
    const err = new TemplateNotFoundError('welcome');
    expect(err.message).toBe('Template not found: welcome');
  });

  test('sets name to TemplateNotFoundError', () => {
    const err = new TemplateNotFoundError('reset-password');
    expect(err.name).toBe('TemplateNotFoundError');
  });

  test('exposes templateName property', () => {
    const err = new TemplateNotFoundError('invoice');
    expect(err.templateName).toBe('invoice');
  });

  test('is instanceof Error', () => {
    const err = new TemplateNotFoundError('test');
    expect(err).toBeInstanceOf(Error);
  });
});
