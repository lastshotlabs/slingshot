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
- Plans / specs / design docs are **Documents** in the API — the briefing lists their title + a `GET .../docs/<id>` URL only (never the body), and there is usually no local file. Fetch by id; never report "can't find it" without fetching first.
- Bug/task found → ticket. Non-obvious fact learned → gotcha.
- END / task complete: update touched ticket/plan/state lifecycles, then create a validated checkpoint (which creates the worklog). Work is NOT done until checked.
- Full protocol: `curl -s -H "Authorization: Bearer $CONTEXTSHOT_TOKEN" "$CONTEXTSHOT_URL/api/protocol?slug=slingshot"`
<!-- contextshot:end -->
