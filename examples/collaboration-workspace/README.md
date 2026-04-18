# Collaboration Workspace Example

Source-backed example for the `/examples/collaboration-workspace/` docs page.

## What it shows

- auth, notifications, and permissions as the shared platform layer
- community plus chat in the same app
- polls and interactions as cross-cutting collaboration features
- assets, emoji, embeds, GIFs, and deep links as media and delivery surfaces

## Files

- `src/index.ts` - code-first composition
- `app.manifest.json` - manifest-first equivalent
- `slingshot.handlers.ts` - auth-to-community bridge

## Run

From the repo root:

```bash
bun examples/collaboration-workspace/src/index.ts
```

Set `JWT_SECRET` and `TENOR_API_KEY` first.
