---
title: Human Guide
description: Human-maintained guidance for @lastshotlabs/slingshot-ai
---

`@lastshotlabs/slingshot-ai` gives an app one provider-neutral surface for AI
generation. See the package `README.md` for the full guide — it is the canonical
document and is kept current.

## When To Use It

Use this package when your app needs to generate text or structured data with an
LLM and you want:

- to swap providers (Anthropic, an OpenAI-compatible endpoint, a local model) in
  config rather than in code;
- structured output that is actually validated, on every provider;
- a spend limit that stops a runaway loop *before* it spends the money;
- to know, per call, whether you got what you asked for.

## The Rules That Matter

- Providers are dumb transports. Policy lives in the orchestrator.
- Nothing degrades silently: read `result.degradations`.
- `usage.costUsd === null` means unknown. It does not mean free.
- Moderation fails closed.
