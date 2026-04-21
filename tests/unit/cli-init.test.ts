import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, mock, test } from 'bun:test';

function makeOclifConfig() {
  return {
    runHook: async () => ({ successes: [], failures: [] }),
    scopedEnvVar: () => undefined,
    scopedEnvVarKey: (key: string) => key,
    scopedEnvVarKeys: () => [],
    bin: 'slingshot',
    userAgent: 'slingshot/test',
    theme: undefined,
    findCommand: () => undefined,
  };
}

describe('cli init', () => {
  const originalCwd = process.cwd();

  afterEach(() => {
    mock.restore();
    process.chdir(originalCwd);
  });

  test('scaffolds a sqlite app with preset auth and no infra', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'slingshot-init-'));
    process.chdir(tempDir);

    const spawnCalls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
    mock.module('child_process', () => ({
      spawnSync: (cmd: string, args: string[], options?: { cwd?: string }) => {
        spawnCalls.push({ cmd, args, cwd: options?.cwd });

        if (cmd === 'bun' && args[0] === 'init' && options?.cwd) {
          mkdirSync(options.cwd, { recursive: true });
          writeFileSync(join(options.cwd, 'index.ts'), 'export {};\n', 'utf8');
          writeFileSync(
            join(options.cwd, 'package.json'),
            JSON.stringify({ name: 'demo', scripts: {}, dependencies: {}, devDependencies: {} }),
            'utf8',
          );
        }

        return { status: 0 };
      },
    }));
    mock.module('../../src/cli/utils/tui', () => ({
      textInput: (_prompt: string, defaultValue?: string) => defaultValue ?? '',
      selectOption: (prompt: string, options: string[]) => {
        if (prompt === 'Database setup:') {
          return options[1];
        }
        if (prompt === 'How would you like to configure auth?') {
          return options[0];
        }
        if (prompt === 'Which best describes your app?') {
          return options[0];
        }
        if (prompt === 'Set up deployment infrastructure?') {
          return options[1];
        }
        return options[0];
      },
    }));

    const Init = (await import(`../../src/cli/commands/init.ts?init=${Date.now()}`)).default;
    const command = new Init(['My App', 'my-app'], makeOclifConfig() as never);

    await command.run();

    const projectDir = join(tempDir, 'my-app');
    expect(existsSync(join(projectDir, 'src', 'config', 'index.ts'))).toBe(true);
    expect(existsSync(join(projectDir, 'src', 'lib', 'constants.ts'))).toBe(true);
    expect(existsSync(join(projectDir, '.env'))).toBe(true);

    const config = readFileSync(join(projectDir, 'src', 'config', 'index.ts'), 'utf8');
    const env = readFileSync(join(projectDir, '.env'), 'utf8');
    const pkg = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8'));

    expect(config).toContain('auth: "sqlite"');
    expect(config).toContain('sessions: "sqlite"');
    expect(config).toContain('sqlite: path.join(import.meta.dir, "../../data.db")');
    expect(env).toContain('JWT_SECRET=');
    expect(pkg.module).toBe('src/index.ts');
    expect(pkg.scripts.dev).toBe('bun --watch src/index.ts');
    expect(spawnCalls.map(call => `${call.cmd} ${call.args.join(' ')}`)).toEqual([
      'bun init -y',
      'git init',
      'bun install',
    ]);
  });
});
