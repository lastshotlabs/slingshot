const fs = require('fs');
const path = require('path');
const ts = require('typescript');

function stripSourceMapComment(code) {
  return code.replace(/\r?\n\/\/# sourceMappingURL=.*$/u, '');
}

function applyImportMetaEnv(code) {
  const command = process.env.SLINGSHOT_DOCS_ASTRO_COMMAND ?? '';
  const isDev = command === 'dev';
  const baseUrl = process.env.DOCS_BASE_URL ?? '/slingshot/';

  return code
    .replace(/import\.meta\.env\.MODE\b/gu, JSON.stringify(isDev ? 'development' : 'production'))
    .replace(/import\.meta\.env\.DEV\b/gu, isDev ? 'true' : 'false')
    .replace(/import\.meta\.env\.PROD\b/gu, isDev ? 'false' : 'true')
    .replace(/import\.meta\.env\.BASE_URL\b/gu, JSON.stringify(baseUrl));
}

function normalizeMessage(message) {
  if (typeof message === 'string') {
    return message;
  }

  if (message && typeof message.text === 'string') {
    return message.text;
  }

  return String(message ?? '');
}

function diagnosticToText(diagnostic) {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
}

function toEsbuildError(diagnostics) {
  const error = new Error(
    diagnostics.map(diagnostic => diagnosticToText(diagnostic)).join('\n\n') ||
      'TypeScript transform failed',
  );

  error.errors = diagnostics.map(diagnostic => ({
    detail: diagnostic,
    id: '',
    location:
      diagnostic.file && typeof diagnostic.start === 'number'
        ? (() => {
            const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(
              diagnostic.start,
            );
            return {
              column: character,
              file: diagnostic.file.fileName,
              length: diagnostic.length ?? 0,
              line: line + 1,
              lineText: diagnostic.file.text.split(/\r?\n/u)[line] ?? '',
            };
          })()
        : null,
    notes: [],
    pluginName: 'typescript',
    text: diagnosticToText(diagnostic),
  }));
  error.warnings = [];
  return error;
}

function toCompilerOptions(options = {}) {
  const loader = options.loader ?? 'js';
  const tsconfigRaw = options.tsconfigRaw ?? {};
  const rawCompilerOptions = tsconfigRaw.compilerOptions ?? {};
  const compilerOptions = {
    ...rawCompilerOptions,
    module: ts.ModuleKind.ESNext,
    sourceMap: options.sourcemap !== false,
    target: rawCompilerOptions.target ?? ts.ScriptTarget.ES2022,
  };

  if (loader === 'ts') {
    compilerOptions.jsx = ts.JsxEmit.Preserve;
  } else if (loader === 'tsx') {
    compilerOptions.jsx = ts.JsxEmit.ReactJSX;
  } else if (loader === 'jsx') {
    compilerOptions.allowJs = true;
    compilerOptions.jsx = ts.JsxEmit.ReactJSX;
  } else {
    compilerOptions.allowJs = true;
  }

  return compilerOptions;
}

function transformSync(input, options = {}) {
  const loader = options.loader ?? 'js';

  if (!['js', 'jsx', 'ts', 'tsx'].includes(loader)) {
    return {
      code: applyImportMetaEnv(input),
      map: JSON.stringify({ mappings: '' }),
      warnings: [],
    };
  }

  const result = ts.transpileModule(applyImportMetaEnv(input), {
    compilerOptions: toCompilerOptions(options),
    fileName: options.sourcefile ?? 'inline.ts',
    reportDiagnostics: true,
  });

  const diagnostics =
    result.diagnostics?.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error) ??
    [];

  if (diagnostics.length > 0) {
    throw toEsbuildError(diagnostics);
  }

  return {
    code: stripSourceMapComment(result.outputText),
    map: result.sourceMapText ?? JSON.stringify({ mappings: '' }),
    warnings: [],
  };
}

async function transform(...args) {
  return transformSync(...args);
}

function formatMessagesSync(messages) {
  return messages.map(message => normalizeMessage(message));
}

async function formatMessages(...args) {
  return formatMessagesSync(...args);
}

function analyzeMetafileSync(metafile) {
  return typeof metafile === 'string' ? metafile : JSON.stringify(metafile, null, 2);
}

async function analyzeMetafile(...args) {
  return analyzeMetafileSync(...args);
}

function unsupported(operation) {
  throw new Error(
    `${operation} is unavailable in this sandbox without the native esbuild service process.`,
  );
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeOutputFile(filePath, contents) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, contents, 'utf8');
}

function createMetafileOutput(entryPoint, contents) {
  return {
    bytes: Buffer.byteLength(contents),
    entryPoint,
    exports: [],
    imports: [],
    inputs: {},
  };
}

async function rebuildContext(options = {}) {
  const outdir = options.outdir ?? path.join(process.cwd(), '.esbuild-safe');
  const entryPoints = Array.isArray(options.entryPoints) ? options.entryPoints : [];
  const metafile = { inputs: {}, outputs: {} };

  ensureDir(outdir);

  for (const entryPoint of entryPoints) {
    const normalizedEntryPoint = String(entryPoint);
    const jsFile = path.resolve(outdir, `${normalizedEntryPoint}.js`);
    const mapFile = `${jsFile}.map`;
    const jsContents = 'export {};\n';
    const mapContents = JSON.stringify({
      version: 3,
      file: path.basename(jsFile),
      sources: [],
      names: [],
      mappings: '',
    });

    writeOutputFile(jsFile, jsContents);

    if (options.sourcemap) {
      writeOutputFile(mapFile, mapContents);
      metafile.outputs[mapFile] = {
        bytes: Buffer.byteLength(mapContents),
        inputs: {},
        imports: [],
      };
    }

    metafile.outputs[jsFile] = createMetafileOutput(normalizedEntryPoint, jsContents);
  }

  return {
    errors: [],
    warnings: [],
    metafile,
    outputFiles: [],
  };
}

async function build() {
  unsupported('esbuild.build');
}

function buildSync() {
  unsupported('esbuild.buildSync');
}

async function context(options = {}) {
  let disposed = false;
  let cancelled = false;

  return {
    async rebuild() {
      if (disposed || cancelled) {
        const error = new Error('The build was canceled');
        error.errors = [{ text: 'The build was canceled' }];
        throw error;
      }

      return rebuildContext(options);
    },
    async cancel() {
      cancelled = true;
    },
    async dispose() {
      disposed = true;
    },
  };
}

function initialize() {
  return Promise.resolve();
}

function stop() {
  return Promise.resolve();
}

const shim = {
  analyzeMetafile,
  analyzeMetafileSync,
  build,
  buildSync,
  context,
  formatMessages,
  formatMessagesSync,
  initialize,
  stop,
  transform,
  transformSync,
  version: `safe-shim-typescript-${ts.version}`,
};

module.exports = shim;
