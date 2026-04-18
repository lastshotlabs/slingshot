---
title: AI Draft
description: AI-assisted summary for @lastshotlabs/slingshot-permissions
---

> AI-assisted draft. Use this page as the quick map of the permissions package before reading the human guide.

## Summary

`@lastshotlabs/slingshot-permissions` is the policy engine library for the Slingshot workspace. It is
not a plugin by itself. Instead, it gives feature packages a shared registry, evaluator, and
persistence adapters for grant-based authorization.

The package is where permission semantics should live: roles map to actions through a registry,
adapters store grants, evaluators resolve allow and deny behavior, and helpers such as
`seedSuperAdmin()` handle bootstrap concerns.

## What This Package Owns

- registry creation and resource-type definitions
- evaluator creation and permission checks
- memory, SQLite, Postgres, and Mongo adapters
- testing utilities for memory-backed permission setups

## Common Flows

- create a registry, register resource types, then create an adapter and evaluator
- pass the resulting permissions state to packages like admin or community that need policy checks
- use the memory adapter in tests and local experiments when persistence is not the point

## Important Reminder

Because this is a library package rather than a plugin, the integration docs need to live partly in
the consuming packages too. Readers need examples of how permissions state is handed off, not just
API listings.
