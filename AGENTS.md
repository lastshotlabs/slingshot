# Agent Guide

See [CLAUDE.md](CLAUDE.md) for the repository guidance, test command split, and contributor rules.

This file intentionally delegates to `CLAUDE.md` to avoid drift.

<!-- contextshot:begin -->

# Slingshot

Context lives in Contextshot (project: slingshot). Content in the DB, not this file.
(If $CONTEXTSHOT_URL/$CONTEXTSHOT_TOKEN are unset: source ~/.config/contextshot/env)

## Session protocol

- START: read the briefing:
  `curl -s -H "Authorization: Bearer $CONTEXTSHOT_TOKEN" "$CONTEXTSHOT_URL/api/projects/slingshot/briefing"`
- Bug/task found → ticket. Non-obvious fact learned → gotcha.
- END / task complete: write a worklog, update state if it changed. Work is NOT done until logged.
- Full protocol: `curl -s -H "Authorization: Bearer $CONTEXTSHOT_TOKEN" "$CONTEXTSHOT_URL/api/protocol?slug=slingshot"`
<!-- contextshot:end -->
