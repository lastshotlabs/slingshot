# Collaboration Workspace Example

Source-backed example for the `/examples/collaboration-workspace/` docs page.

## What it shows

- auth, notifications, and permissions as the shared platform layer
- community plus chat in the same app
- polls and interactions as cross-cutting collaboration features
- assets, emoji, embeds, GIFs, and deep links as media and delivery surfaces

## Files

- `app.config.ts` - typed app config and plugin composition

## Run

From the repo root:

```bash
slingshot start --config examples/collaboration-workspace/app.config.ts
```

Set `JWT_SECRET` and `TENOR_API_KEY` first.
