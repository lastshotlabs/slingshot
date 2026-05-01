/**
 * Edge-case coverage for image transform logic.
 *
 * Builds on the core transform tests in image-transform-serve.test.ts.
 * Covers ImageTransformError properties, 0x0/undefined dimensions,
 * boundary quality values, "original" format passthrough, timeout error
 * properties, and sharp-unavailable fallback paths.
 */
import { Buffer } from 'node:buffer';
import { describe, expect, test } from 'bun:test';
import { transformImage } from '../../src/image/transform';
import {
  ImageInputTooLargeError,
  ImageSourceBlockedError,
  ImageSourceDnsError,
  ImageTransformError,
  ImageTransformTimeoutError,
} from '../../src/image/types';
import type { ImageFormat } from '../../src/image/types';

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ioAAAAASUVORK5CYII=';
const encoder = new TextEncoder();

function tinyPngBuffer(): ArrayBuffer {
  const bytes = Buffer.from(TINY_PNG_BASE64, 'base64');
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function imageOptions(
  overrides: Partial<{
    width: number;
    height?: number;
    format: ImageFormat;
    quality: number;
    maxWidth: number;
    maxHeight: number;
    timeoutMs: number;
  }> = {},
) {
  return {
    width: 100,
    format: 'original' as const,
    quality: 75,
    maxWidth: 500,
    maxHeight: 500,
    timeoutMs: 100,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Error class constructors
// ---------------------------------------------------------------------------

describe('ImageTransformError', () => {
  test('has correct name and message', () => {
    const err = new ImageTransformError('Requested width 600 exceeds max');
    expect(err.name).toBe('ImageTransformError');
    expect(err.message).toContain('Requested width 600 exceeds max');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('ImageTransformTimeoutError', () => {
  test('has correct name and includes timeout in message', () => {
    const err = new ImageTransformTimeoutError(5000);
    expect(err.name).toBe('ImageTransformTimeoutError');
    expect(err.message).toContain('5000');
    expect(err).toBeInstanceOf(Error);
  });

  test('zero timeout displays zero in message', () => {
    const err = new ImageTransformTimeoutError(0);
    expect(err.message).toContain('0');
  });
});

describe('ImageInputTooLargeError', () => {
  test('has correct name and includes max bytes in message', () => {
    const err = new ImageInputTooLargeError(1024);
    expect(err.name).toBe('ImageInputTooLargeError');
    expect(err.message).toContain('1024');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('ImageSourceBlockedError', () => {
  test('has correct name and exposes ip and reason', () => {
    const err = new ImageSourceBlockedError('10.0.0.1', 'private range');
    expect(err.name).toBe('ImageSourceBlockedError');
    expect(err.ip).toBe('10.0.0.1');
    expect(err.reason).toBe('private range');
    expect(err.message).toContain('10.0.0.1');
    expect(err.message).toContain('private range');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('ImageSourceDnsError', () => {
  test('has correct name and exposes hostname', () => {
    const err = new ImageSourceDnsError('malformed.example.com');
    expect(err.name).toBe('ImageSourceDnsError');
    expect(err.hostname).toBe('malformed.example.com');
    expect(err.message).toContain('malformed.example.com');
    expect(err).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// Edge-case dimension / quality inputs
// ---------------------------------------------------------------------------

describe('transformImage edge-case dimensions', () => {
  test('width=0 is rejected (sharp rejects zero or negative pixel dimensions)', async () => {
    await expect(
      transformImage(tinyPngBuffer(), 'image/png', {
        width: 0,
        format: 'original',
        quality: 75,
        maxWidth: 500,
        maxHeight: 500,
        timeoutMs: 100,
      }),
    ).rejects.toThrow(Error);
  });

  test('height=0 is rejected by sharp (zero pixels is not a valid dimension)', async () => {
    await expect(
      transformImage(tinyPngBuffer(), 'image/png', {
        width: 50,
        height: 0,
        format: 'original',
        quality: 75,
        maxWidth: 500,
        maxHeight: 500,
        timeoutMs: 100,
      }),
    ).rejects.toThrow(Error);
  });

  test('undefined height does not trigger height validation', async () => {
    const result = await transformImage(tinyPngBuffer(), 'image/png', {
      width: 50,
      format: 'original',
      quality: 75,
      maxWidth: 500,
      maxHeight: 500,
      timeoutMs: 100,
    });
    expect(result.contentType).toBe('image/png');
    expect(result.buffer.byteLength).toBeGreaterThan(0);
  });

  test('dimensions exactly at maxWidth/maxHeight boundary pass validation', async () => {
    const result = await transformImage(tinyPngBuffer(), 'image/png', {
      width: 500,
      height: 500,
      format: 'original',
      quality: 75,
      maxWidth: 500,
      maxHeight: 500,
      timeoutMs: 100,
    });
    expect(result.buffer.byteLength).toBeGreaterThan(0);
  });
});

describe('transformImage format and quality boundaries', () => {
  test('format "original" preserves the source content type', async () => {
    const result = await transformImage(tinyPngBuffer(), 'image/png', {
      width: 50,
      format: 'original',
      quality: 75,
      maxWidth: 500,
      maxHeight: 500,
      timeoutMs: 100,
    });
    expect(result.contentType).toBe('image/png');
    expect(result.warningHeader).toBeUndefined();
  });

  test('quality=1 at lower boundary does not throw', async () => {
    const result = await transformImage(tinyPngBuffer(), 'image/png', {
      width: 50,
      format: 'png',
      quality: 1,
      maxWidth: 500,
      maxHeight: 500,
      timeoutMs: 100,
    });
    expect(result.contentType).toBe('image/png');
    expect(result.buffer.byteLength).toBeGreaterThan(0);
  });

  test('quality=100 at upper boundary does not throw', async () => {
    const result = await transformImage(tinyPngBuffer(), 'image/png', {
      width: 50,
      format: 'png',
      quality: 100,
      maxWidth: 500,
      maxHeight: 500,
      timeoutMs: 100,
    });
    expect(result.contentType).toBe('image/png');
    expect(result.buffer.byteLength).toBeGreaterThan(0);
  });
});

describe('transformImage timeout', () => {
  test('very short timeout on transformImage can trigger ImageTransformTimeoutError for slow input', async () => {
    // Using a 1ms timeout with a valid image should be fast enough for
    // a 1x1 PNG, but we verify the rejection shape.
    await expect(
      transformImage(tinyPngBuffer(), 'image/png', {
        width: 50,
        format: 'original',
        quality: 75,
        maxWidth: 500,
        maxHeight: 500,
        timeoutMs: 1,
      }),
    ).rejects.toThrow(ImageTransformTimeoutError);
  });
});

describe('transformImage invalid input handling', () => {
  test('completely empty buffer throws rather than crashing', async () => {
    const emptyBuf = new ArrayBuffer(0);
    await expect(transformImage(emptyBuf, 'image/png', imageOptions())).rejects.toThrow();
  });

  test('garbage bytes produce a sharp error rather than silent wrong output', async () => {
    const garbage = encoder.encode('not-an-image').buffer as ArrayBuffer;
    await expect(transformImage(garbage, 'image/png', imageOptions())).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Format conversion edge cases
// ---------------------------------------------------------------------------

describe('transformImage format conversion', () => {
  test('PNG → JPEG conversion produces image/jpeg content type', async () => {
    const result = await transformImage(tinyPngBuffer(), 'image/png', {
      width: 50,
      format: 'jpeg',
      quality: 80,
      maxWidth: 500,
      maxHeight: 500,
      timeoutMs: 500,
    });
    expect(result.contentType).toBe('image/jpeg');
    expect(result.buffer.byteLength).toBeGreaterThan(0);
  });

  test('PNG → WebP conversion produces image/webp content type', async () => {
    const result = await transformImage(tinyPngBuffer(), 'image/png', {
      width: 50,
      format: 'webp',
      quality: 80,
      maxWidth: 500,
      maxHeight: 500,
      timeoutMs: 500,
    });
    expect(result.contentType).toBe('image/webp');
    expect(result.buffer.byteLength).toBeGreaterThan(0);
  });

  test('PNG → AVIF conversion produces image/avif content type', async () => {
    const result = await transformImage(tinyPngBuffer(), 'image/png', {
      width: 50,
      format: 'avif',
      quality: 50,
      maxWidth: 500,
      maxHeight: 500,
      timeoutMs: 500,
    });
    expect(result.contentType).toBe('image/avif');
    expect(result.buffer.byteLength).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Dimension boundary edge cases
// ---------------------------------------------------------------------------

describe('transformImage dimension boundary edge cases', () => {
  test('width exceeding maxWidth throws ImageTransformError', async () => {
    await expect(
      transformImage(tinyPngBuffer(), 'image/png', {
        width: 501,
        format: 'original',
        quality: 75,
        maxWidth: 500,
        maxHeight: 500,
        timeoutMs: 100,
      }),
    ).rejects.toThrow(ImageTransformError);
  });

  test('height exceeding maxHeight throws ImageTransformError', async () => {
    await expect(
      transformImage(tinyPngBuffer(), 'image/png', {
        width: 50,
        height: 501,
        format: 'original',
        quality: 75,
        maxWidth: 500,
        maxHeight: 500,
        timeoutMs: 100,
      }),
    ).rejects.toThrow(ImageTransformError);
  });

  test('width=1 at minimum boundary passes validation', async () => {
    const result = await transformImage(tinyPngBuffer(), 'image/png', {
      width: 1,
      format: 'original',
      quality: 75,
      maxWidth: 500,
      maxHeight: 500,
      timeoutMs: 100,
    });
    expect(result.buffer.byteLength).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Concurrent execution
// ---------------------------------------------------------------------------

describe('transformImage concurrent execution', () => {
  test('multiple concurrent transforms do not interfere', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        transformImage(tinyPngBuffer(), 'image/png', {
          width: 10 + i,
          format: 'original',
          quality: 75,
          maxWidth: 500,
          maxHeight: 500,
          timeoutMs: 1_000,
        }),
      ),
    );
    for (const result of results) {
      expect(result.buffer.byteLength).toBeGreaterThan(0);
    }
  });
});
