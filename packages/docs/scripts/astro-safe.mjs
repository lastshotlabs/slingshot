import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import Module, { registerHooks, syncBuiltinESMExports } from 'node:module';
import { dirname, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const originalExec = childProcess.exec;
const originalSpawn = childProcess.spawn;
const originalModuleLoad = Module._load;
const esbuildShimUrl = pathToFileURL(resolve(__dirname, 'esbuild-safe-shim.mjs')).href;
const esbuildShimPath = resolve(__dirname, 'esbuild-safe-shim.cjs');

async function detectSpawnBlocked() {
  return new Promise((resolve, reject) => {
    let settled = false;
    let child;

    try {
      child = originalSpawn(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      if (error?.code === 'EPERM') {
        resolve(true);
        return;
      }

      reject(error);
      return;
    }

    child.once('error', error => {
      settled = true;

      if (error?.code === 'EPERM') {
        resolve(true);
        return;
      }

      reject(error);
    });

    child.once('close', () => {
      if (!settled) {
        child.kill();
        resolve(false);
      }
    });
  });
}

const spawnBlocked = await detectSpawnBlocked();

if (!process.env.SLINGSHOT_DOCS_ASTRO_COMMAND && process.argv.length >= 3) {
  process.env.SLINGSHOT_DOCS_ASTRO_COMMAND = process.argv[2];
}
if (spawnBlocked) {
  process.env.SLINGSHOT_DOCS_SPAWN_BLOCKED = '1';
}

function createNoopChildProcess(callback, error) {
  const child = new EventEmitter();
  child.pid = undefined;
  child.stdin = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => false;

  queueMicrotask(() => {
    callback?.(error, '', '');
    child.stdout.end();
    child.stderr.end();
    child.emit('close', 1, null);
    child.emit('exit', 1, null);
  });

  return child;
}

function createAsyncChildProcess(task) {
  const child = new EventEmitter();
  child.pid = undefined;
  child.stdin = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => false;

  queueMicrotask(async () => {
    try {
      await task();
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 0, null);
      child.emit('exit', 0, null);
    } catch (error) {
      console.error(error);
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 1, null);
      child.emit('exit', 1, null);
    }
  });

  return child;
}

async function runPagefindFromNpxArgs(args, options = {}) {
  if (spawnBlocked) {
    return;
  }

  return originalSpawn.call(this, 'npx', args, options);
}

childProcess.exec = function patchedExec(command, options, callback) {
  let resolvedOptions = options;
  let resolvedCallback = callback;

  if (typeof resolvedOptions === 'function') {
    resolvedCallback = resolvedOptions;
    resolvedOptions = undefined;
  }

  try {
    return originalExec.call(this, command, resolvedOptions, resolvedCallback);
  } catch (error) {
    const normalizedCommand =
      typeof command === 'string'
        ? command.trim().toLowerCase()
        : String(command).trim().toLowerCase();

    if (
      process.platform === 'win32' &&
      normalizedCommand === 'net use' &&
      error?.code === 'EPERM'
    ) {
      return createNoopChildProcess(resolvedCallback, error);
    }

    throw error;
  }
};

if (spawnBlocked) {
  childProcess.spawn = function patchedSpawn(command, args, options) {
    const normalizedCommand =
      typeof command === 'string'
        ? command.trim().toLowerCase()
        : String(command).trim().toLowerCase();
    const normalizedArgs = Array.isArray(args) ? args : [];

    if (normalizedCommand === 'npx' && normalizedArgs.includes('pagefind')) {
      return createAsyncChildProcess(() => runPagefindFromNpxArgs(normalizedArgs, options));
    }

    return originalSpawn.call(this, command, args, options);
  };

  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'esbuild') {
        return {
          shortCircuit: true,
          url: esbuildShimUrl,
        };
      }

      return nextResolve(specifier, context);
    },
  });

  Module._load = function patchedModuleLoad(request, parent, isMain) {
    const normalizedRequest = typeof request === 'string' ? request.replace(/\\/g, '/') : '';

    if (parent?.filename === esbuildShimPath) {
      return originalModuleLoad.call(this, request, parent, isMain);
    }

    if (normalizedRequest === 'esbuild' || normalizedRequest.endsWith('/esbuild/lib/main.js')) {
      return originalModuleLoad.call(this, esbuildShimPath, parent, isMain);
    }

    return originalModuleLoad.call(this, request, parent, isMain);
  };
}

syncBuiltinESMExports();

const { cli } = await import('../node_modules/astro/dist/cli/index.js');

try {
  await cli(process.argv);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
