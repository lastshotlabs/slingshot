type AlsConstructor = typeof import('node:async_hooks').AsyncLocalStorage;

type ProcessWithBuiltinModule = typeof process & {
  getBuiltinModule?: (id: string) => object | undefined;
};

function getNodeAsyncHooksModule(): typeof import('node:async_hooks') | null {
  if (typeof process === 'undefined') return null;
  const proc = process as ProcessWithBuiltinModule;
  if (typeof proc.getBuiltinModule !== 'function') return null;

  const asyncHooks = proc.getBuiltinModule('node:async_hooks');
  if (
    typeof asyncHooks === 'object' &&
    asyncHooks !== null &&
    'AsyncLocalStorage' in asyncHooks
  ) {
    return asyncHooks as typeof import('node:async_hooks');
  }

  return null;
}

export function getAsyncLocalStorageConstructor(): AlsConstructor | null {
  if (typeof (globalThis as Record<string, unknown>).AsyncLocalStorage !== 'undefined') {
    return (globalThis as Record<string, unknown>).AsyncLocalStorage as AlsConstructor;
  }

  return getNodeAsyncHooksModule()?.AsyncLocalStorage ?? null;
}
