import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';

describe('CLI tooling', () => {
  afterEach(() => {
    mock.restore();
  });

  test('CLI entrypoint delegates to oclif run and flush', async () => {
    const run = mock(async () => {});
    const flush = mock(async () => {});
    const originalArgv = process.argv;
    const actualOclif = await import('@oclif/core');

    process.argv = ['bun', 'slingshot', 'deploy', '--help'];
    mock.module('@oclif/core', () => ({
      ...actualOclif,
      run,
      flush,
    }));

    try {
      await import(`../../src/cli/index.ts?cli=${Date.now()}`);
      expect(run).toHaveBeenCalledWith(['deploy', '--help'], expect.any(String));
      expect(flush).toHaveBeenCalled();
    } finally {
      process.argv = originalArgv;
    }
  });

  test('TTY helpers fall back to line-based prompts when stdin is not a TTY', async () => {
    const responses = ['2\n', '\n', '1 3\n'];
    const readSync = mock((_fd: number, buffer: Buffer) => {
      const next = responses.shift() ?? '';
      buffer.fill(0);
      buffer.write(next);
      return next.length;
    });
    const originalIsTty = process.stdin.isTTY;
    const consoleLog = spyOn(console, 'log').mockImplementation(() => {});
    const stdoutWrite = spyOn(process.stdout, 'write').mockImplementation(() => true);

    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: false,
    });
    mock.module('fs', () => ({ readSync }));

    try {
      const tui = await import(`../../src/cli/utils/tui.ts?tui=${Date.now()}`);

      expect(tui.selectOption('Choose one', ['Alpha', 'Beta'], 0)).toBe('Beta');
      expect(tui.textInput('Name', 'Default Name')).toBe('Default Name');
      expect(tui.multiSelect('Choose many', ['Alpha', 'Beta', 'Gamma'])).toEqual([
        'Alpha',
        'Gamma',
      ]);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', {
        configurable: true,
        value: originalIsTty,
      });
      consoleLog.mockRestore();
      stdoutWrite.mockRestore();
    }
  });
});
