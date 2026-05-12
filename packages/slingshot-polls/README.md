---
title: Human Guide
description: Human-maintained guidance for @lastshotlabs/slingshot-polls
---

`@lastshotlabs/slingshot-polls` adds content-attached multiple-choice polls without baking poll logic
into one domain package. Polls are source-type driven, so chat, community, or other packages can
register handlers for the content they own while reusing the same poll engine.

## When To Use It

Use this package when your app needs:

- polls attached to existing content records
- policy-driven authorization around poll creation, voting, and results
- reusable poll infrastructure that is not hardcoded to chat or community

Do not use it for free-standing survey systems with unrelated lifecycle rules. This package assumes
polls are attached to app content through source handlers and policy resolvers.

## What You Need Before Wiring It In

The package depends on `slingshot-auth`.

To make polls useful, you must supply source handlers and policies for the content types that polls
can attach to. The package registers the shared policy keys, but it does not know your
domain-specific `sourceType` semantics on its own. Handlers are declared at package construction
time via the `sourceHandlers` and `voteHandlers` config fields.

## Minimum Setup

Defaults include:

- `mountPath: '/polls'`
- `closeCheckIntervalMs: 60_000`
- `maxOptions: 10`
- `maxQuestionLength: 500`
- `maxOptionLength: 200`
- `disableRoutes: []`

Optional `rateLimit` settings control poll creation, voting, and results lookups.

## What You Get

The package registers the `Poll` and `PollVote` entities and then layers poll-specific behavior on
top:

- poll creation validation based on configured question and option limits
- vote guards that enforce poll state and per-user voting rules
- a manual `results` route with explicit policy resolution against the underlying poll record
- an auto-close sweep that closes expired polls on an interval
- package state published under `POLLS_PLUGIN_STATE_KEY`

This package is intentionally content-agnostic. Source-policy hooks are the integration seam that
lets other packages adopt it.

## Common Customization

The most important decisions are:

- content limits: `maxOptions`, `maxQuestionLength`, `maxOptionLength`
- `rateLimit` policy for vote-heavy or abuse-prone surfaces
- `disableRoutes` if your app wants to suppress parts of the default route surface
- `closeCheckIntervalMs` for expiry sweep cadence

If you need to change behavior, start in:

- `src/plugin.ts` for lifecycle, route registration, and sweep startup
- `src/validation/config.ts` and `src/validation/polls.ts` for config and input rules
- `src/policy/` for source and vote policy resolution
- `src/operations/` for route-backed behavior

## Gotchas

- The package is not plug-and-play without source handler registration. If no domain supplies poll
  source policies, attach flows will have no meaningful authorization model.
- Source handlers are passed to `createPollsPackage({ sourceHandlers, voteHandlers })` at
  construction time. The runtime `plugin.registerSourceHandler()` API is gone — build the handler
  map upfront and hand it to the package factory:

  ```ts
  createPollsPackage({
    sourceHandlers: {
      'community-thread': communityThreadPollHandler,
    },
    voteHandlers: {
      'community-thread': communityThreadVoteHandler,
    },
  });
  ```
- The auto-close sweep is real runtime behavior. It is not a dev-only task.
- The results route is mounted separately from entity-generated routes because it needs cross-entity
  access and explicit policy checks.
- Built-in rate limiting uses an in-memory backend unless you replace that behavior at the app
  layer. That matters in horizontally scaled deployments.

## Key Files

- `src/index.ts`
- `src/plugin.ts`
- `src/validation/config.ts`
- `src/entities/poll.ts`
- `src/entities/pollVote.ts`
- `src/operations/index.ts`
- `src/policy/index.ts`
