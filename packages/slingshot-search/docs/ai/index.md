---
title: AI Draft
description: AI-assisted summary for @lastshotlabs/slingshot-search
---

> AI-assisted draft. Use this page for the fast mental model of the search package.

## Summary

`@lastshotlabs/slingshot-search` is the config-driven search plugin for Slingshot. It discovers
search-enabled entities, initializes one or more providers, mounts search routes, and keeps
indexes in sync through event-driven workflows.

The package is where provider choice, route exposure, transform registration, and index-sync
behavior come together. It is not just a provider wrapper; it is the runtime that turns entity
search config into live query and indexing behavior.

## What This Package Owns

- per-entity search, suggest, federated, and optional admin routes
- provider initialization and index management
- client-safe search event registration
- testing helpers backed by the DB-native provider

## Common Flows

- configure providers, then add the plugin to the app
- let `setupPost` discover entities with `search` config from the entity registry
- register transforms up front if entity documents need reshaping before indexing

## Important Caveat

Search behavior depends heavily on entity config and sync mode, so package docs and entity docs need
to be read together. Search cannot be understood from provider options alone.
