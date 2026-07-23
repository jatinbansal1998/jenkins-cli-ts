---
name: release
description: >
  Cut a manual prerelease for jenkins-cli-ts: bump package version (unless the
  user specifies one), tag vX.Y.Z, push to trigger .github/workflows/release.yml,
  then write GitHub release notes in the project's cumulative prerelease style.
  Use when the user asks to release, ship, cut a version, publish a prerelease,
  bump and tag, or runs /release.
---

# Release (manual prerelease)

Ship a new **GitHub prerelease** for this repo. Releases are intentional and
manual — post-merge CI only tests; it does not bump versions or open PRs.

## Hard rules

1. **Always prerelease.** Never mark a release as latest/stable unless the user
   explicitly asks to promote a stable release (out of scope for default flow).
2. **Version:** patch-bump `package.json` version unless the user names the next
   version (e.g. `0.8.0`). Tag is always `v` + that version (`v0.7.27`).
3. **Changelog:** write notes in the style of recent prereleases (see
   `references/release-notes-format.md`). Cumulative since the **latest stable**
   release, plus a "New Since previous prerelease" section and compare links.
4. **Publishing path:** commit version → tag → push → wait for Release workflow
   → set custom release body with `gh`. Do not invent alternate publish paths.
5. **Confirm before push** if anything is unexpected (dirty tree, wrong branch,
   tag already exists). Default branch is `main`.

## Preconditions

Run from repo root. Abort with a clear message if any check fails.

```bash
git status
git branch --show-current   # expect main
git fetch --tags origin
git pull --ff-only origin main
```

- Working tree must be clean (or only contain the version bump you are about to make).
- `package.json` version and latest git tag should already match (or explain drift).
- Require `gh` authenticated for this repo.

Inspect current state:

```bash
jq -r .version package.json
git tag --sort=-v:refname | head -20
gh release list --limit 20
```

Identify:

| Variable     | How                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------- |
| `CURRENT`    | `package.json` version (no `v`)                                                                               |
| `PREV_TAG`   | previous release tag, usually `v$CURRENT` if last release matched package.json                                |
| `STABLE_TAG` | latest **non-prerelease** release (`gh release list` / `isPrerelease=false`). Example historically: `v0.7.17` |
| `NEXT`       | user-specified version, else patch bump of `CURRENT` (`0.7.26` → `0.7.27`)                                    |
| `NEXT_TAG`   | `v$NEXT`                                                                                                      |

Patch bump only for the default path. If the user requests minor/major or an exact version, use that.

If `NEXT_TAG` already exists on the remote, stop and ask.

## Step 1 — Version bump commit

Update only `package.json` `"version"` to `NEXT` (keep formatting; trailing newline).

```bash
# after editing package.json
git add package.json
git commit -m "chore: release v${NEXT}"
```

Do not auto-format unrelated files in the release commit.

## Step 2 — Tag and push

```bash
git tag "v${NEXT}"
git push origin main
git push origin "v${NEXT}"
```

Pushing `v*` triggers `.github/workflows/release.yml`, which:

- runs tests
- builds multi-platform binaries (`bun scripts/build.ts --release`)
- creates/updates a **prerelease** via `softprops/action-gh-release` (`prerelease: true`)
- uploads artifacts and may sync the Homebrew tap when `HOMEBREW_TAP_TOKEN` is set

Workflow auto-notes (`generate_release_notes: true`) are a placeholder — **replace** them in the next step.

## Step 3 — Wait for the Release workflow

```bash
gh run list --workflow=release.yml --limit 5
# then watch the run for this tag
gh run watch
```

Confirm the prerelease exists:

```bash
gh release view "v${NEXT}"
```

If the workflow failed, fix and re-run; do not hand-upload binaries unless the user asks.

## Step 4 — Write release notes

Gather changes:

```bash
# commits since previous tag
git log --oneline "${PREV_TAG}..v${NEXT}"

# full ranges used in the notes footer
# previous prerelease → this:  ${PREV_TAG}...v${NEXT}
# latest stable → this:        ${STABLE_TAG}...v${NEXT}

gh release view "${PREV_TAG}" --json body -q .body   # reuse structure / roll prior "New Since" into cumulative
gh release view "${STABLE_TAG}" --json tagName,isPrerelease
```

Also skim meaningful diffs under `src/`, `scripts/`, `install`, tests, and docs that affect users.

Write notes following **`references/release-notes-format.md`** exactly:

1. Title heading `## v${NEXT}`
2. One intro paragraph: prerelease; all changes since latest stable `${STABLE_TAG}`; includes prior prereleases `${after stable}` through `${PREV}` when applicable
3. `### New Since v${PREV}` — detailed bullets for **this** release only (user-facing themes with `####` subheads)
4. `### Included from vA to v${PREV}` — condensed cumulative highlights from intermediate prereleases (omit this section if this is the first prerelease after stable)
5. `### Full Changelogs` — two compare links (prev prerelease range + stable range)

Tone: user-facing, concrete, no internal-only noise (CI chore bumps, pure refactors without user impact). Group related work under short `####` titles.

Apply the body (prerelease flag must stay true):

```bash
gh release edit "v${NEXT}" --prerelease --notes-file /tmp/release-notes-v${NEXT}.md
```

Or `--notes "$(cat <<'EOF' ... EOF)"` for shorter bodies.

Verify:

```bash
gh release view "v${NEXT}"
```

## Step 5 — Report back

Tell the user:

- Version / tag published
- Release URL: `gh release view "v${NEXT}" --json url -q .url`
- That it is a **prerelease** (stable channel users will not auto-upgrade to it)
- Homebrew tap sync status if the workflow summary mentions it
- Anything skipped or failed

## Out of scope (unless user explicitly asks)

- Promoting a release to **stable** / unsetting prerelease / making it latest
- Changing `version-policy.json` minVersion
- Releasing from a non-`main` commit
- Force-pushing tags

## Quick checklist

- [ ] On `main`, clean, up to date
- [ ] `NEXT` chosen (user or patch bump)
- [ ] `package.json` bumped and committed
- [ ] Tag `v${NEXT}` pushed
- [ ] Release workflow green
- [ ] Custom cumulative prerelease notes applied
- [ ] Release remains `prerelease: true`
