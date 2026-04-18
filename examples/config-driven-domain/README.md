# Config-Driven Domain Example

Source-backed example for the `/examples/config-driven-domain/` docs page.

## What it shows

- entity definition with indexes, permission scope, and emitted events
- operation definitions for transitions and search
- plugin assembly with `createEntityPlugin()`
- app composition beside `slingshot-auth`

## Files

- `src/entities/post.ts`
- `src/entities/postOperations.ts`
- `src/plugin.ts`
- `src/index.ts`

## Run

From the repo root:

```bash
bun examples/config-driven-domain/src/index.ts
```

Set `JWT_SECRET` first.
