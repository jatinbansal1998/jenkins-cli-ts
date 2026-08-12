---
name: release
description: >
  Cut a manual stable release for jenkins-cli-ts: bump package version (unless the
  user specifies one), tag vX.Y.Z, push to trigger .github/workflows/release.yml,
  then write GitHub release notes in the project's release-notes style.
  Use when the user asks to release, ship, cut a version, publish, bump and tag,
  or runs /release.
---

# Release (manual stable release)

Ship a new **GitHub release** for this repo. Releases are intentional and
manual — post-merge CI only tests; it does not bump versions or open PRs.

## Hard rules

1. **Always stable.** `.github/workflows/release.yml` publishes with
   `prerelease: false` and `make_latest: true`. Do not publish prereleases: the
   curl installer downloads from `releases/latest/download` and the Homebrew tap
   formula is synced on every tag, so a prerelease leaves installer users on an
   older binary than the formula points at.
2. **Version:** patch-bump `package.json` version unless the user names the next
   version (e.g. `0.9.0`). Tag is always `v` + that version (`v0.8.13`).
3. **Changelog:** write notes covering everything since the previous release (see
   `references/release-notes-format.md`), plus a compare link.
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

| Variable   | How                                                                            |
| ---------- | ------------------------------------------------------------------------------ |
| `CURRENT`  | `package.json` version (no `v`)                                                |
| `PREV_TAG` | previous release tag, usually `v$CURRENT` if last release matched package.json |
| `NEXT`     | user-specified version, else patch bump of `CURRENT` (`0.8.12` → `0.8.13`)     |
| `NEXT_TAG` | `v$NEXT`                                                                       |

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
- creates/updates the release via `softprops/action-gh-release` as latest/stable
- uploads artifacts and syncs the Homebrew tap when `HOMEBREW_TAP_TOKEN` is set
- validates the published assets on Linux, macOS, and Windows against a real Jenkins

Workflow auto-notes (`generate_release_notes: true`) are a placeholder — **replace** them in the next step.

## Step 3 — Wait for the Release workflow

```bash
gh run list --workflow=release.yml --limit 5
# then watch the run for this tag
gh run watch
```

Confirm the release exists and is latest:

```bash
gh release view "v${NEXT}"
gh api repos/{owner}/{repo}/releases/latest -q '.tag_name, .prerelease'
```

If the workflow failed, fix and re-run; do not hand-upload binaries unless the user asks.

## Step 4 — Write release notes

Gather changes:

```bash
# commits since previous release
git log --oneline "${PREV_TAG}..v${NEXT}"

# range used in the notes footer: ${PREV_TAG}...v${NEXT}

gh release view "${PREV_TAG}" --json body -q .body   # reuse structure
```

Also skim meaningful diffs under `src/`, `scripts/`, `install`, tests, and docs that affect users.

Write notes following **`references/release-notes-format.md`** exactly:

1. Title heading `## v${NEXT}`
2. One intro paragraph naming the previous release the changes build on
3. `####`-grouped user-facing themes
4. `### Full Changelog` — compare link `${PREV_TAG}...v${NEXT}`

Tone: user-facing, concrete, no internal-only noise (CI chore bumps, pure refactors without user impact). Group related work under short `####` titles.

Apply the body:

```bash
gh release edit "v${NEXT}" --notes-file /tmp/release-notes-v${NEXT}.md
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
- That it is the **latest stable** release (stable-channel users and the curl
  installer pick it up)
- Homebrew tap sync status if the workflow summary mentions it
- Anything skipped or failed

## Out of scope (unless user explicitly asks)

- Publishing a prerelease or unsetting latest
- Changing `version-policy.json` minVersion
- Releasing from a non-`main` commit
- Force-pushing tags

## Quick checklist

- [ ] On `main`, clean, up to date
- [ ] `NEXT` chosen (user or patch bump)
- [ ] `package.json` bumped and committed
- [ ] Tag `v${NEXT}` pushed
- [ ] Release workflow green (including asset validation)
- [ ] Custom release notes applied
- [ ] Release is latest, `prerelease: false`
