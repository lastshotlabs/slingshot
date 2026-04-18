function isVerbose(): boolean {
  const v = process.env.LOGGING_VERBOSE;
  return v !== undefined ? v === 'true' : process.env.NODE_ENV !== 'production';
}

export const log = (...args: unknown[]) => {
  if (isVerbose()) console.log(...args);
};

/**
 * Like log(), but also requires LOGGING_AUTH_TRACE=true. Use for lines that include user/session IDs.
 * The env var is read on each call so tests and long-running processes can
 * toggle trace logging without re-importing the module.
 */
export const authTrace = (...args: unknown[]) => {
  if (process.env.LOGGING_AUTH_TRACE === 'true') log(...args);
};
