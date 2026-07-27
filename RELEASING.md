# Releasing

Versioning is driven by [Changesets](https://github.com/changesets/changesets). The
`Publish Packages` workflow publishes to both **GitHub Packages** (`npm.pkg.github.com`) and
the public npm registry.

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
   runs `scripts/publish.ts --target=github --publish --skip-existing` followed by the npm
   registry publish.

`scripts/publish.ts` rewrites each package's `workspace:*` cross-dependencies to the concrete
published version. `bun run hardening:core` then runs `verify:packed-artifacts`, which stages
packages through that same publication code, packs every tarball, checks manifest/export and
dependency integrity, and installs each package in an isolated consumer before importing its
public subpaths. Do not bypass this gate when preparing a release.

## Notes

- GitHub Packages consumers need a `read:packages` token in `~/.npmrc`; public npm consumers
  do not.
- `docs` is excluded from the workspace and the private package is skipped — changesets won't
  ask to version them.
- The legacy `release` / `release:patch` / `release:minor` scripts remain as a manual fallback
  but the changesets flow above is the canonical path.
