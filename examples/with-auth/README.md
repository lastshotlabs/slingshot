# Auth Setup Example

Source-backed example for the `/examples/with-auth/` docs page.

## What it shows

- `createServer()` with `createAuthPlugin()`
- in-memory auth, sessions, and OAuth state
- matching manifest and code-first setup

## Files

- `src/index.ts` - code-first app bootstrap
- `app.manifest.json` - manifest-first equivalent

## Run

From the repo root:

```bash
bun examples/with-auth/src/index.ts
```

Set `JWT_SECRET` first.
