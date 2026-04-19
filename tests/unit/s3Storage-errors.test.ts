import { describe, test, expect } from 'bun:test';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// s3Storage — error paths for missing AWS SDK packages
//
// These tests cover the catch blocks in requireS3Client(), requirePresigner(),
// and requireLibStorage() (lines 71-72, 79-82, 89-91 in s3Storage.ts).
//
// Since the packages ARE installed in the workspace, we use subprocess
// execution with module resolution overrides to simulate missing packages.
// This avoids mock.module() process-global pollution.
// ---------------------------------------------------------------------------

const srcRoot = resolve(import.meta.dir, '..', '..').replace(/\\/g, '/');

async function runScript(script: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(['bun', '--eval', script], {
    cwd: resolve(import.meta.dir, '..', '..'),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  proc.stdin!.end();
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

function blockPackageScript(blockedPackage: string, adapterCall: string): string {
  return `
    const Module = require("node:module");
    const origResolveFilename = Module._resolveFilename;
    Module._resolveFilename = function(id) {
      if (id === "${blockedPackage}") {
        throw new Error("Cannot find module: " + id);
      }
      return origResolveFilename.apply(this, arguments);
    };

    const { s3Storage } = require("${srcRoot}/src/framework/adapters/s3Storage.ts");
    const adapter = s3Storage({ bucket: "test", streaming: true });
    ${adapterCall}
  `;
}

describe('s3Storage — missing package errors', () => {
  test('throws informative error when @aws-sdk/client-s3 is missing', async () => {
    const script = blockPackageScript(
      '@aws-sdk/client-s3',
      `adapter.get("file.txt").then(
        () => console.log("UNEXPECTED"),
        (e) => console.log("ERROR:" + e.message)
      );`,
    );
    const { stdout } = await runScript(script);
    expect(stdout).toContain('@aws-sdk/client-s3 is not installed');
    expect(stdout).toContain('bun add @aws-sdk/client-s3');
  });

  test('throws informative error when @aws-sdk/s3-request-presigner is missing', async () => {
    const script = blockPackageScript(
      '@aws-sdk/s3-request-presigner',
      `try {
        adapter.presignGet("file.txt", { expirySeconds: 300 });
        console.log("UNEXPECTED");
      } catch(e) {
        console.log("ERROR:" + e.message);
      }`,
    );
    const { stdout } = await runScript(script);
    expect(stdout).toContain('@aws-sdk/s3-request-presigner is not installed');
    expect(stdout).toContain('bun add @aws-sdk/s3-request-presigner');
  });

  test('throws informative error when @aws-sdk/lib-storage is missing', async () => {
    const script = blockPackageScript(
      '@aws-sdk/lib-storage',
      `
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data"));
          controller.close();
        },
      });
      adapter.put("file.bin", stream, { mimeType: "application/octet-stream" }).then(
        () => console.log("UNEXPECTED"),
        (e) => console.log("ERROR:" + e.message)
      );`,
    );
    const { stdout } = await runScript(script);
    expect(stdout).toContain('@aws-sdk/lib-storage is not installed');
    expect(stdout).toContain('bun add @aws-sdk/lib-storage');
  });
});
