# Releasing

Versioning is driven by [Changesets](https://github.com/changesets/changesets); publishing
goes to **GitHub Packages** (`npm.pkg.github.com`, `@lastshotlabs` scope) via the
`Publish Packages` workflow. Public npm is intentionally not a target.

## Day-to-day: describe your change

When a PR changes a publishable package, add a changeset (instead of bumping `version` by hand):

```bash
bun changeset
```

Pick the affected packages and bump type (patch / minor / major) and write a one-line summary.
This drops a markdown file under `.changeset/`. Commit it with your PR.

## Cutting a release

1. Apply the accumulated changesets — this computes per-package version bumps and writes
   changelogs:

   ```bash
   bun version-packages   # = changeset version
   ```

2. Commit the version + changelog changes, then create a GitHub Release for the new tag.
   The release `published` event triggers `.github/workflows/publish.yml`, which builds and
   runs `scripts/publish.ts --target=github --publish --skip-existing`.

`scripts/publish.ts` rewrites each package's `workspace:*` cross-dependencies to the concrete
published version, so the packages install cleanly outside the monorepo.

## Notes

- `access` is `restricted` (GitHub Packages); consumers need a `read:packages` token in their
  `~/.npmrc` to install.
- `docs` is excluded from the workspace and the private package is skipped — changesets won't
  ask to version them.
- The legacy `release` / `release:patch` / `release:minor` scripts remain as a manual fallback
  but the changesets flow above is the canonical path.
