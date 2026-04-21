import { resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';

// ---------------------------------------------------------------------------
// TUI utility tests — subprocess-based
//
// The tui.ts functions (selectOption, textInput, multiSelect) use synchronous
// fd 0 reads (readSync) and are inherently interactive.  To test them without
// mock.module() we spawn a child process with controlled stdin and examine the
// output / exit code.
//
// In the subprocess, process.stdin.isTTY is falsy (piped), so the functions
// take their non-TTY fallback paths which print numbered options and read a
// line from stdin.
// ---------------------------------------------------------------------------

const srcRoot = resolve(import.meta.dir, '..', '..');

/**
 * Spawn a short-lived bun process that runs an inline script.
 * Writes `input` to its stdin, collects stdout, and returns it.
 */
async function runTuiScript(
  script: string,
  input: string,
): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(['bun', '--eval', script], {
    cwd: srcRoot,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, BUN_ENV: 'test' },
  });

  // Write input and close stdin so readSync returns
  const writer = proc.stdin!;
  writer.write(input);
  writer.end();

  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout, exitCode };
}

// ---------------------------------------------------------------------------
// selectOption
// ---------------------------------------------------------------------------

describe('selectOption (non-TTY fallback)', () => {
  test('returns default option when input is empty', async () => {
    const script = `
      const { selectOption } = require("${srcRoot.replace(/\\/g, '/')}/src/cli/utils/tui.ts");
      const result = selectOption("Pick one:", ["alpha", "beta", "gamma"], 1);
      process.stdout.write("RESULT:" + result);
    `;
    const { stdout, exitCode } = await runTuiScript(script, '\n');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('RESULT:beta');
  });

  test('returns selected option by number', async () => {
    const script = `
      const { selectOption } = require("${srcRoot.replace(/\\/g, '/')}/src/cli/utils/tui.ts");
      const result = selectOption("Pick:", ["a", "b", "c"]);
      process.stdout.write("RESULT:" + result);
    `;
    const { stdout, exitCode } = await runTuiScript(script, '3\n');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('RESULT:c');
  });

  test('returns default when number is out of range', async () => {
    const script = `
      const { selectOption } = require("${srcRoot.replace(/\\/g, '/')}/src/cli/utils/tui.ts");
      const result = selectOption("Pick:", ["x", "y"], 0);
      process.stdout.write("RESULT:" + result);
    `;
    const { stdout, exitCode } = await runTuiScript(script, '9\n');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('RESULT:x');
  });

  test('prints prompt and numbered options', async () => {
    const script = `
      const { selectOption } = require("${srcRoot.replace(/\\/g, '/')}/src/cli/utils/tui.ts");
      selectOption("Choose an item:", ["foo", "bar"]);
    `;
    const { stdout, exitCode } = await runTuiScript(script, '\n');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Choose an item:');
    expect(stdout).toContain('1) foo');
    expect(stdout).toContain('2) bar');
  });

  test('uses defaultIndex 0 when not specified', async () => {
    const script = `
      const { selectOption } = require("${srcRoot.replace(/\\/g, '/')}/src/cli/utils/tui.ts");
      const result = selectOption("Pick:", ["first", "second"]);
      process.stdout.write("RESULT:" + result);
    `;
    const { stdout, exitCode } = await runTuiScript(script, '\n');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('RESULT:first');
  });
});

// ---------------------------------------------------------------------------
// textInput
// ---------------------------------------------------------------------------

describe('textInput (non-TTY fallback)', () => {
  test('returns typed text', async () => {
    const script = `
      const { textInput } = require("${srcRoot.replace(/\\/g, '/')}/src/cli/utils/tui.ts");
      const result = textInput("Name");
      process.stdout.write("RESULT:" + result);
    `;
    const { stdout, exitCode } = await runTuiScript(script, 'Alice\n');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('RESULT:Alice');
  });

  test('returns default value when input is empty', async () => {
    const script = `
      const { textInput } = require("${srcRoot.replace(/\\/g, '/')}/src/cli/utils/tui.ts");
      const result = textInput("Name", "DefaultName");
      process.stdout.write("RESULT:" + result);
    `;
    const { stdout, exitCode } = await runTuiScript(script, '\n');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('RESULT:DefaultName');
  });

  test('returns empty string when no default and empty input', async () => {
    const script = `
      const { textInput } = require("${srcRoot.replace(/\\/g, '/')}/src/cli/utils/tui.ts");
      const result = textInput("Name");
      process.stdout.write("RESULT:[" + result + "]");
    `;
    const { stdout, exitCode } = await runTuiScript(script, '\n');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('RESULT:[]');
  });

  test('shows default value in prompt', async () => {
    const script = `
      const { textInput } = require("${srcRoot.replace(/\\/g, '/')}/src/cli/utils/tui.ts");
      textInput("Port", "3000");
    `;
    const { stdout, exitCode } = await runTuiScript(script, '\n');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('(3000)');
  });
});

// ---------------------------------------------------------------------------
// multiSelect
// ---------------------------------------------------------------------------

describe('multiSelect (non-TTY fallback)', () => {
  test('returns defaults when input is empty', async () => {
    const script = `
      const { multiSelect } = require("${srcRoot.replace(/\\/g, '/')}/src/cli/utils/tui.ts");
      const result = multiSelect("Features:", ["a", "b", "c"], ["a", "c"]);
      process.stdout.write("RESULT:" + JSON.stringify(result));
    `;
    const { stdout, exitCode } = await runTuiScript(script, '\n');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('RESULT:["a","c"]');
  });

  test('returns selected items by number', async () => {
    const script = `
      const { multiSelect } = require("${srcRoot.replace(/\\/g, '/')}/src/cli/utils/tui.ts");
      const result = multiSelect("Pick:", ["x", "y", "z"]);
      process.stdout.write("RESULT:" + JSON.stringify(result));
    `;
    const { stdout, exitCode } = await runTuiScript(script, '1 3\n');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('RESULT:["x","z"]');
  });

  test('ignores out-of-range numbers', async () => {
    const script = `
      const { multiSelect } = require("${srcRoot.replace(/\\/g, '/')}/src/cli/utils/tui.ts");
      const result = multiSelect("Pick:", ["a", "b"]);
      process.stdout.write("RESULT:" + JSON.stringify(result));
    `;
    const { stdout, exitCode } = await runTuiScript(script, '1 5 2\n');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('RESULT:["a","b"]');
  });

  test('prints options with default markers', async () => {
    const script = `
      const { multiSelect } = require("${srcRoot.replace(/\\/g, '/')}/src/cli/utils/tui.ts");
      multiSelect("Features:", ["one", "two"], ["two"]);
    `;
    const { stdout, exitCode } = await runTuiScript(script, '\n');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('1) one');
    expect(stdout).toContain('2) two');
    expect(stdout).toContain('[default]');
  });

  test('returns empty array when no defaults and no input numbers match', async () => {
    const script = `
      const { multiSelect } = require("${srcRoot.replace(/\\/g, '/')}/src/cli/utils/tui.ts");
      const result = multiSelect("Pick:", ["a", "b"]);
      process.stdout.write("RESULT:" + JSON.stringify(result));
    `;
    const { stdout, exitCode } = await runTuiScript(script, '99\n');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('RESULT:[]');
  });

  test('returns empty array when no defaults and empty input', async () => {
    const script = `
      const { multiSelect } = require("${srcRoot.replace(/\\/g, '/')}/src/cli/utils/tui.ts");
      const result = multiSelect("Pick:", ["a", "b"]);
      process.stdout.write("RESULT:" + JSON.stringify(result));
    `;
    const { stdout, exitCode } = await runTuiScript(script, '\n');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('RESULT:[]');
  });
});
