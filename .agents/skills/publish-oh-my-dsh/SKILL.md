---
name: publish-oh-my-dsh
description: Prepare, audit, or recover oh-my-dsh releases across npm and GitHub. Use for version readiness, Release Please PRs, first interactive publication of @vanducng/dsh-tui and @vanducng/oh-my-dsh, trusted-publisher setup, and verifying or recovering a partially completed release.
---

# Publish oh-my-dsh

Release Please is the release authority. It owns version bumps, changelog dated sections, Git tags, and GitHub Releases. GitHub Actions publishes both npm packages with OIDC after a release tag exists. The agent prepares, audits, and recovers; it never invokes `npm publish` or `pnpm publish`.

## Establish scope

1. Read the repository `AGENTS.md`.
2. Confirm this repository by checking the private root name `oh-my-dsh`, `@vanducng/oh-my-dsh` in `apps/omdsh/package.json`, and `@vanducng/dsh-tui` in `packages/tui/omdsh-tui/package.json`.
3. Confirm `origin` is `vanducng/oh-my-dsh` before any GitHub write.

Classify the request:

- **Prepare:** Make the tree releasable. Do not publish, push, tag, or create a GitHub Release unless asked.
- **First npm publish:** The new scoped names do not exist on npm yet. Give the user the exact interactive pack-and-publish commands. Do not run them.
- **Audit or recovery:** Inspect npm, Git, and GitHub. Perform only the missing authorized operations.

## Inspect release state

```sh
git status --short --branch
git log -5 --oneline --decorate
git remote -v
git tag --sort=-version:refname
npm view @vanducng/dsh-tui version
npm view @vanducng/oh-my-dsh version
gh release list --limit 10
```

Also inspect the three manifest versions, `.release-please-manifest.json`, `CHANGELOG.md`, and commits since the last tag.

## Ordinary releases

After the first versions exist and trusted publishing is configured:

1. Land Conventional Commits on `main`.
2. `.github/workflows/publish.yml` opens or updates the Release Please PR.
3. CI jobs `test (22)` and `test (24)` must pass. The workflow auto-merges a green release PR.
4. The same workflow run validates the tag, packs both tarballs, publishes `@vanducng/dsh-tui` first, then `@vanducng/oh-my-dsh`, and reads both versions back from npm.

Do not add a second changelog, tag, or publish path. Do not hand-edit dated changelog sections or the Release Please manifest except during explicit recovery.

## First publication of the new names

A trusted publisher cannot create a missing package. After a local `pnpm build` and `pnpm test:package`, give the user these commands in order and wait:

```sh
release_pack_dir="$(mktemp -d)"
pnpm --filter @vanducng/dsh-tui pack --pack-destination "$release_pack_dir"
pnpm --filter @vanducng/oh-my-dsh pack --pack-destination "$release_pack_dir"
npm publish --access public "$release_pack_dir"/vanducng-dsh-tui-*.tgz
npm publish --access public "$release_pack_dir"/vanducng-oh-my-dsh-*.tgz
```

Then the user configures trust from an npm 11.15+ client with package write access:

```sh
npm trust github @vanducng/dsh-tui --file publish.yml --repository vanducng/oh-my-dsh --environment npm --allow-publish
npm trust github @vanducng/oh-my-dsh --file publish.yml --repository vanducng/oh-my-dsh --environment npm --allow-publish
npm trust list @vanducng/dsh-tui
npm trust list @vanducng/oh-my-dsh
```

The GitHub environment name must remain `npm`. Later releases use OIDC in `.github/workflows/publish.yml`. If OIDC returns `E404`, the package is missing or the repository, workflow filename, environment, or allowed action do not match.

## Verify packed artifacts

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm check:md
pnpm smoke:happy
pnpm test:package
git diff --check
```

`pnpm test:package` must prove:

- Both tarball names and versions match the manifests.
- The CLI tarball exposes `omdsh`, `lib/bin.js`, and `config/cordis.yml`.
- The packed CLI depends on `@vanducng/dsh-tui` at a published version, not `workspace:`.
- No packed file points into `refs/` or a local workspace path.

## Final audit

```sh
npm view @vanducng/dsh-tui@X.Y.Z version dist-tags.latest
npm view @vanducng/oh-my-dsh@X.Y.Z version dist-tags.latest
git ls-remote --tags origin refs/tags/vX.Y.Z refs/tags/vX.Y.Z^{}
gh release view vX.Y.Z
git status --short --branch
```

Report the version, npm results, tag, GitHub Release URL, and any deferred human step. At the first-publish checkpoint, report the exact commands and stop.
