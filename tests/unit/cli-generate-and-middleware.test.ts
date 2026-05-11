import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';

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

type LoggableCommand = { log(message?: string, ...args: unknown[]): void };

function captureLogs<T extends LoggableCommand>(command: T): string[] {
  const logs: string[] = [];
  const logSpy = spyOn(command, 'log') as unknown as {
    mockImplementation(fn: LoggableCommand['log']): unknown;
  };
  logSpy.mockImplementation((message?: string, ...args: unknown[]) => {
    if (message === undefined) return;
    logs.push([message, ...args].map(String).join(' '));
  });
  return logs;
}

afterEach(() => {
  mock.restore();
});

describe('generate command and framework middleware', () => {
  test('generates entities from a definition module export', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'slingshot-generate-'));
    const definitionPath = join(tempDir, 'entity.ts');
    const outDir = join(tempDir, 'generated');
    const calls: Array<{ kind: string; outDir: string; migration: boolean; dryRun: boolean }> = [];

    writeFileSync(
      definitionPath,
      'export const User = { name: "User", fields: {}, _pkField: "id", _storageName: "users" };\n',
      'utf8',
    );

    mock.module('@lastshotlabs/slingshot-entity', () => ({
      writeGenerated: (
        config: { name: string },
        options: { outDir: string; migration: boolean; dryRun: boolean },
      ) => {
        calls.push({
          kind: config.name,
          outDir: options.outDir,
          migration: options.migration,
          dryRun: options.dryRun,
        });
        return options.migration
          ? { 'index.ts': '// generated', 'migrations/001.sql': '-- migration' }
          : { 'index.ts': '// generated' };
      },
    }));

    const Generate = (await import(`../../src/cli/commands/generate.ts?gen=${Date.now()}`)).default;

    const definitionCommand = new Generate(
      ['--definition', definitionPath, '--outdir', outDir, '--migration'],
      makeOclifConfig() as never,
    );
    const definitionLogs = captureLogs(definitionCommand);
    await definitionCommand.run();
    expect(definitionLogs.join('\n')).toContain('User: generated 1 source file(s)');
    expect(definitionLogs.join('\n')).toContain('User: generated 1 migration file(s):');
    expect(calls[0]).toEqual({
      kind: 'User',
      outDir,
      migration: true,
      dryRun: false,
    });

    rmSync(tempDir, { recursive: true, force: true });
  });

  test('applies middleware in order and logs request metadata', async () => {
    const middlewareModule = await import(
      `../../src/framework/middleware/index.ts?mw=${Date.now()}`
    );
    const loggerModule = await import(
      `../../src/framework/middleware/logger.ts?logger=${Date.now()}`
    );

    const order: string[] = [];
    const handler = middlewareModule.applyMiddleware(
      async (_req: Request) => {
        order.push('handler');
        return new Response('ok', { status: 201 });
      },
      async (req: Request, next: (request: Request) => Promise<Response> | Response) => {
        order.push('outer:before');
        const response = await next(req);
        order.push('outer:after');
        return response;
      },
      async (req: Request, next: (request: Request) => Promise<Response> | Response) => {
        order.push('inner:before');
        const response = await next(req);
        order.push('inner:after');
        return response;
      },
    );

    const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    const response = await loggerModule.logger(
      new Request('https://example.com/api/items', { method: 'POST' }),
      handler,
    );

    expect(response.status).toBe(201);
    expect(order).toEqual([
      'outer:before',
      'inner:before',
      'handler',
      'inner:after',
      'outer:after',
    ]);
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(String(consoleSpy.mock.calls[0]?.[0])).toContain('POST /api/items 201');
  });
});
