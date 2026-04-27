import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { emitPackageStabilityWarning } from '../../src/stability';

describe('emitPackageStabilityWarning', () => {
  let emitWarningSpy: ReturnType<typeof spyOn> | null = null;

  afterEach(() => {
    emitWarningSpy?.mockRestore();
    emitWarningSpy = null;
  });

  test('emits an ExperimentalWarning once per package and stability label', () => {
    emitWarningSpy = spyOn(process, 'emitWarning').mockImplementation(() => undefined);

    emitPackageStabilityWarning('@lastshotlabs/slingshot-auth', 'experimental');
    emitPackageStabilityWarning('@lastshotlabs/slingshot-auth', 'experimental');

    expect(emitWarningSpy).toHaveBeenCalledTimes(1);
    expect(emitWarningSpy.mock.calls[0]).toEqual([
      'Slingshot package "@lastshotlabs/slingshot-auth" is experimental.',
      'ExperimentalWarning',
      'SLINGSHOT_AUTH_EXPERIMENTAL',
    ]);
  });

  test('includes detail text in the warning message', () => {
    emitWarningSpy = spyOn(process, 'emitWarning').mockImplementation(() => undefined);

    emitPackageStabilityWarning(
      '@lastshotlabs/slingshot-oauth',
      'beta',
      'Install this package from the next channel while it is under active development.',
    );

    expect(emitWarningSpy).toHaveBeenCalledTimes(1);
    expect(String(emitWarningSpy.mock.calls[0]?.[0])).toContain('is beta.');
    expect(String(emitWarningSpy.mock.calls[0]?.[0])).toContain('next channel');
  });
});
