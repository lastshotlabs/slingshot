---
title: Notes
description: Working notes for @lastshotlabs/slingshot-community
---

## Current Focus Areas

- Keep the plugin thin and prevent route-by-route logic from creeping back in.
- Watch the moderation, scoring, and notification paths because they are the most side-effect heavy parts of the package.
- Keep auth and permissions assumptions explicit when adding new entity operations.

## Good Next Docs

- A per-entity matrix for routes, permissions, middleware names, and emitted events.
- A notification flow page covering replies, mentions, and ban-related delivery.
- A moderation guide describing the interaction between reports, bans, auto moderation, and admin gates.

## Review Checklist

- Did a new feature land as config plus middleware, or did it start rebuilding an old service layer?
- Did an entity change forget to update event consumers or permission registration?
- Did a side effect move into a route path that should really be event-driven?

## Private Notes

Add `private.md` next to this file for product notes, moderation policy experiments, or backlog ideas that should stay untracked.
