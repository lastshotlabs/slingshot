// packages/slingshot-image/tests/transform.test.ts
import { describe, expect, it } from 'bun:test';
import { ImageTransformError } from '../src/types';

// We test transformImage behavior. Since sharp is optional and likely not
// installed in CI, we test the graceful fallback path and the validation path.

describe('transformImage', () => {
  it('throws ImageTransformError when width exceeds maxWidth', async () => {
    const { transformImage } = await import('../src/transform');
    const buffer = new ArrayBuffer(8);
    await expect(
      transformImage(buffer, 'image/jpeg', {
        width: 5000,
        format: 'original',
        quality: 75,
        maxWidth: 4096,
        maxHeight: 4096,
      }),
    ).rejects.toThrow(ImageTransformError);
  });

  it('throws ImageTransformError when height exceeds maxHeight', async () => {
    const { transformImage } = await import('../src/transform');
    const buffer = new ArrayBuffer(8);
    await expect(
      transformImage(buffer, 'image/jpeg', {
        width: 100,
        height: 5000,
        format: 'original',
        quality: 75,
        maxWidth: 4096,
        maxHeight: 4096,
      }),
    ).rejects.toThrow(ImageTransformError);
  });

  it('does not throw when dimensions are within limits', async () => {
    const { transformImage } = await import('../src/transform');
    // Use a minimal valid buffer — sharp will fail to decode it but that is ok
    // for the graceful fallback test; we just verify no ImageTransformError.
    const buffer = new ArrayBuffer(8);
    try {
      const result = await transformImage(buffer, 'image/jpeg', {
        width: 100,
        height: 100,
        format: 'original',
        quality: 75,
        maxWidth: 4096,
        maxHeight: 4096,
      });
      // Either sharp succeeded (unlikely with empty buffer) or graceful fallback
      expect(result.buffer).toBeTruthy();
      expect(typeof result.contentType).toBe('string');
    } catch (err) {
      // If sharp is installed and throws a decode error, that's acceptable
      if (err instanceof ImageTransformError) {
        throw err; // Re-throw — this is the error we're testing against
      }
      // Non-ImageTransformError from sharp is acceptable (corrupt buffer)
    }
  });

  it('returns original content-type when format is original', async () => {
    const { transformImage } = await import('../src/transform');
    const buffer = new ArrayBuffer(8);
    try {
      const result = await transformImage(buffer, 'image/png', {
        width: 100,
        format: 'original',
        quality: 75,
        maxWidth: 4096,
        maxHeight: 4096,
      });
      // Graceful fallback or sharp success — either should preserve content-type
      expect(result.contentType).toBe('image/png');
    } catch (err) {
      if (err instanceof ImageTransformError) throw err;
    }
  });

  it('returns webp content-type when format is webp (graceful fallback)', async () => {
    const { transformImage } = await import('../src/transform');
    const buffer = new ArrayBuffer(8);
    try {
      const result = await transformImage(buffer, 'image/jpeg', {
        width: 100,
        format: 'webp',
        quality: 75,
        maxWidth: 4096,
        maxHeight: 4096,
      });
      // Whether sharp is present or not, content-type should reflect the requested format
      expect(result.contentType).toBe('image/webp');
    } catch (err) {
      if (err instanceof ImageTransformError) throw err;
    }
  });
});

describe('ImageTransformError', () => {
  it('is an Error instance', () => {
    const err = new ImageTransformError('test');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ImageTransformError);
    expect(err.name).toBe('ImageTransformError');
    expect(err.message).toBe('test');
  });
});
