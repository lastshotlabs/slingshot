# Auth Setup Example

Source-backed example for the `/examples/with-auth/` docs page.

## What it shows

- `createServer()` with `createAuthPlugin()`
- in-memory auth, sessions, and OAuth state
- typed app config setup

## Files

- `app.config.ts` - typed app config

## Run

From the repo root:

```bash
slingshot start --config examples/with-auth/app.config.ts
```

Set `JWT_SECRET` first.
