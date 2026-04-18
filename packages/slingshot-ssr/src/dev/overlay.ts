// packages/slingshot-ssr/src/dev/overlay.ts

/**
 * Generates a styled HTML error overlay for dev mode.
 *
 * Returned as a 500 HTML response when a render error occurs and `devMode: true`
 * is set in the plugin config. Provides a full-page error display with:
 * - Error type and message (HTML-escaped)
 * - Stack trace with VS Code deeplinks for each frame
 * - Request context (URL, params, loaderFile) if provided
 *
 * Uses only inline CSS — no external stylesheets or scripts are loaded.
 *
 * @param err - The error that was thrown during SSR render.
 * @param context - Optional request context for additional diagnostic info.
 * @returns A complete HTML string suitable for a 500 response body.
 */
export function buildDevErrorOverlay(
  err: Error,
  context?: {
    /** The request URL pathname. */
    url?: string;
    /** Dynamic route params at the time of the error. */
    params?: Record<string, string>;
    /** Absolute path to the loader/route file being rendered. */
    loaderFile?: string;
  },
): string {
  const errorType = escapeHtml(err.constructor.name);
  const errorMessage = escapeHtml(err.message);
  const stackFrames = formatStack(err.stack ?? '');

  const contextRows =
    context !== undefined
      ? [
          context.url !== undefined
            ? `<tr><td class="ctx-key">URL</td><td class="ctx-val">${escapeHtml(context.url)}</td></tr>`
            : '',
          context.loaderFile !== undefined
            ? `<tr><td class="ctx-key">Loader</td><td class="ctx-val">${escapeHtml(context.loaderFile)}</td></tr>`
            : '',
          Object.keys(context.params ?? {}).length > 0
            ? `<tr><td class="ctx-key">Params</td><td class="ctx-val">${escapeHtml(JSON.stringify(context.params))}</td></tr>`
            : '',
        ]
          .filter(Boolean)
          .join('\n')
      : '';

  const contextSection =
    contextRows !== ''
      ? `
    <section class="section">
      <h2 class="section-title">Request Context</h2>
      <table class="ctx-table">
        <tbody>${contextRows}</tbody>
      </table>
    </section>`
      : '';

  const stackSection =
    stackFrames.length > 0
      ? `
    <section class="section">
      <h2 class="section-title">Stack Trace</h2>
      <ol class="stack-list">
        ${stackFrames.map(f => `<li class="stack-frame">${f}</li>`).join('\n        ')}
      </ol>
    </section>`
      : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SSR Error — slingshot dev</title>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{background:#0f0f11;color:#e4e4e7;font-family:'SF Mono','Fira Code','Cascadia Code',Menlo,monospace;font-size:14px;line-height:1.6;min-height:100vh;padding:0}
    .overlay{max-width:900px;margin:0 auto;padding:2rem 1.5rem}
    .badge{display:inline-block;background:#7f1d1d;color:#fca5a5;border:1px solid #991b1b;border-radius:4px;padding:2px 8px;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;margin-bottom:1rem}
    .error-type{font-size:13px;color:#f87171;font-weight:600;margin-bottom:.4rem;opacity:.85}
    .error-message{font-size:1.35rem;font-weight:700;color:#fff;word-break:break-word;margin-bottom:1.75rem;font-family:'SF Pro Display','Segoe UI',system-ui,sans-serif}
    .section{margin-bottom:2rem}
    .section-title{font-size:11px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:#71717a;margin-bottom:.75rem}
    .ctx-table{border-collapse:collapse;width:100%}
    .ctx-key{color:#a1a1aa;padding:4px 12px 4px 0;width:90px;white-space:nowrap;vertical-align:top}
    .ctx-val{color:#e4e4e7;word-break:break-all}
    .stack-list{list-style:none;counter-reset:frame}
    .stack-frame{counter-increment:frame;display:flex;align-items:baseline;gap:.75rem;padding:5px 0;border-top:1px solid #27272a;font-size:13px;color:#a1a1aa}
    .stack-frame::before{content:counter(frame);min-width:1.5em;text-align:right;color:#52525b;font-size:11px}
    .frame-fn{color:#c4b5fd;white-space:nowrap;flex-shrink:0}
    .frame-loc{color:#6b7280;flex:1;word-break:break-all}
    .frame-loc a{color:#60a5fa;text-decoration:none}
    .frame-loc a:hover{text-decoration:underline}
    .divider{height:1px;background:#27272a;margin:1.5rem 0}
    .footer{font-size:11px;color:#52525b;margin-top:2rem}
  </style>
</head>
<body>
  <div class="overlay">
    <span class="badge">SSR Error</span>
    <div class="error-type">${errorType}</div>
    <div class="error-message">${errorMessage}</div>
    <div class="divider"></div>
    ${contextSection}
    ${stackSection}
    <div class="footer">slingshot-ssr dev mode — this overlay is only shown in development</div>
  </div>
</body>
</html>`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * HTML-escape a string for safe injection into an HTML document.
 * Covers the five characters required by the HTML spec.
 *
 * @internal
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * Parse a stack trace string into formatted HTML fragments.
 *
 * For each frame, attempts to extract the file path, line, and column from the
 * standard V8 stack format. When a local absolute path is detected, wraps it in
 * a `vscode://file/` deeplink for one-click navigation.
 *
 * @internal
 */
function formatStack(stack: string): string[] {
  const lines = stack.split('\n');
  const frames: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('at ')) continue;

    // V8 frame format: "at FnName (/abs/path/to/file.ts:line:col)"
    // or:              "at /abs/path/to/file.ts:line:col"
    const withNameMatch = /^at\s+(.+?)\s+\((.+?)(?::(\d+)(?::(\d+))?)?\)$/.exec(trimmed);
    const withoutNameMatch = /^at\s+(.+?)(?::(\d+)(?::(\d+))?)?$/.exec(trimmed);

    if (withNameMatch) {
      const fnName = escapeHtml(withNameMatch[1]);
      const loc = withNameMatch[2];
      const lineNum = withNameMatch[3];
      const colNum = withNameMatch[4];
      frames.push(
        `<span class="frame-fn">${fnName}</span>` +
          `<span class="frame-loc">${formatLocation(loc, lineNum, colNum)}</span>`,
      );
    } else if (withoutNameMatch) {
      const loc = withoutNameMatch[1];
      const lineNum = withoutNameMatch[2];
      const colNum = withoutNameMatch[3];
      frames.push(
        `<span class="frame-fn">&lt;anonymous&gt;</span>` +
          `<span class="frame-loc">${formatLocation(loc, lineNum, colNum)}</span>`,
      );
    }
  }

  return frames;
}

/**
 * Format a file location string into HTML, wrapping local paths in VS Code deeplinks.
 *
 * @internal
 */
function formatLocation(
  loc: string,
  lineNum: string | undefined,
  colNum: string | undefined,
): string {
  const isLocalPath = loc.startsWith('/') || /^[A-Za-z]:/.test(loc);
  const suffix = [lineNum, colNum].filter(Boolean).join(':');
  const displayLoc = escapeHtml(loc) + (suffix ? ':' + suffix : '');

  if (isLocalPath) {
    const vscodePath = encodeURIComponent(loc);
    const vscodeUrl = `vscode://file/${vscodePath}${lineNum ? ':' + lineNum : ''}${colNum ? ':' + colNum : ''}`;
    return `<a href="${escapeHtml(vscodeUrl)}" title="Open in VS Code">${displayLoc}</a>`;
  }

  return displayLoc;
}
