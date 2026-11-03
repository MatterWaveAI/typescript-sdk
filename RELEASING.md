# Releasing `@matterwave/sdk`

Releases are cut from `main` and published to npm by
[`.github/workflows/publish-npm.yml`](.github/workflows/publish-npm.yml)
with provenance and OIDC trusted publishing. Day-to-day work lands on
`develop`; `main` advances only when cutting a release.

## 1. Prepare and verify on `develop`

1. Make sure all local gates pass on `develop`:

   ```bash
   sh scripts/check-ticket-ids.sh
   pnpm lint
   pnpm typecheck
   pnpm test
   pnpm build
   pnpm attw
   ```

2. Bump the package version in `package.json` and update `VERSION` in
   `src/client.ts` (`src/version.ts` / `VERSION` exported from `src/index.ts`,
   verified against `package.json` by `tests/release-script.test.ts`).
3. Update [`CHANGELOG.md`](CHANGELOG.md): move the entries under
   `## [Unreleased]` into a new `## [X.Y.Z] - YYYY-MM-DD` section (following
   [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
   [`VERSIONING.md`](VERSIONING.md)).
4. Verify the release helper against the new version and tag:

   ```bash
   node scripts/release.mjs check-tag vX.Y.Z
   node scripts/release.mjs notes X.Y.Z
   ```

5. Commit the version bump and changelog update on `develop`, push to
   `origin/develop`, and wait for the `ci` and `docs` workflows to pass.

## 2. Merge `develop` into `main`

Open a pull request from `develop` into `main` (or fast-forward `main` to
`develop` once CI is green):

```bash
git checkout main
git pull --ff-only origin main
git merge --ff-only origin/develop
git push origin main
```

## 3. Tag `vX.Y.Z` on `main`

Tag the release commit on `main` and push the tag to `origin`:

```bash
git checkout main
node scripts/release.mjs check-tag vX.Y.Z
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

## 4. Verify the npm publish workflow

Pushing `vX.Y.Z` triggers `.github/workflows/publish-npm.yml`, which runs two
jobs:

1. **`publish`**:
   - Verifies the commit is an ancestor of `origin/main`
     (`git fetch origin main` and
     `git merge-base --is-ancestor "$GITHUB_SHA" origin/main`) so a tag on an
     unmerged branch can never be published.
   - Verifies the tag matches `package.json` via
     `node scripts/release.mjs check-tag "$TAG"`.
   - Runs `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and
     `pnpm attw`.
   - Generates a CycloneDX SBOM (`sbom.cdx.json`), extracts the version's
     release notes (`notes.md`) from `CHANGELOG.md`, packs the tarball, and
     publishes `@matterwave/sdk` to npm with `--provenance --access public` in
     the `npm` GitHub environment.
2. **`release`**:
   - Creates the GitHub release for `vX.Y.Z` with `notes.md` as the body and
     attaches the packed tarball and `sbom.cdx.json`.

Confirm on the Actions tab that both jobs succeed, check the new release on
GitHub Releases, and verify the package on npm:

```bash
npm view @matterwave/sdk@X.Y.Z version dist.attestations
```
