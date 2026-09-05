---
name: release
description: >
  Cut a manual stable release for jenkins-cli-ts: bump package version (unless the
  user specifies one), tag vX.Y.Z, push to trigger .github/workflows/release.yml,
  then write GitHub release notes in the project's release-notes style.
  Also use to audit or correct existing release notes.
  Use when the user asks to release, ship, cut a version, publish, bump and tag,
  or runs /release.
---

# Release (manual stable release)

Ship a new **GitHub release** for this repo. Releases are intentional and
manual — post-merge CI only tests; it does not bump versions or open PRs.

## Hard rules

1. **Stable by default.** The tag shape decides the channel in
   `.github/workflows/release.yml`: a plain tag (`v0.8.13`) publishes as
   latest/stable and syncs the Homebrew tap; a semver prerelease tag
   (`v0.9.0-rc.1`) publishes as a prerelease and skips the tap sync. Only cut a
   prerelease when the user asks for one — the curl installer downloads from
   `releases/latest/download`, so prereleases are invisible to it by design.
2. **Version:** patch-bump `package.json` version unless the user names the next
   version (e.g. `0.9.0`). Tag is always `v` + that version (`v0.8.13`).
   `scripts/build.ts` fails the build unless the tag matches `package.json`
   exactly, so an `-rc.1` tag needs `"version": "0.9.0-rc.1"` in `package.json`.
3. **Changelog:** cover everything since the previous stable release. For later
   RCs, group changes by release, newest first, retaining earlier RC sections.
   Read `references/release-notes-format.md` for baselines and compare links.
4. **Publishing path:** commit version → tag → push → wait for Release workflow
   → set custom release body with `gh`. Do not invent alternate publish paths.
5. **Confirm before push** if anything is unexpected (dirty tree, wrong branch,
   tag already exists). Default branch is `main`.

## Correct existing notes

For a notes-only request, skip version bumps, branch updates, tags, and release
workflow execution. Read the target release, earlier RC notes in the same series,
and the preceding stable release. Check their claims against the corresponding
tag ranges, apply the format reference, then edit only the requested release
bodies with `gh release edit --notes-file`. Read them back to verify the published
text and unchanged channel. Do not infer authorization to rewrite unrelated history.

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

| Variable   | How                                                                        |
| ---------- | -------------------------------------------------------------------------- |
| `CURRENT`  | `package.json` version (no `v`)                                            |
| `PREV_TAG` | previous stable release tag; excludes RCs even when `CURRENT` is an RC     |
| `NEXT`     | user-specified version, else patch bump of `CURRENT` (`0.8.12` → `0.8.13`) |
| `NEXT_TAG` | `v$NEXT`                                                                   |

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
- creates/updates the release via `softprops/action-gh-release`, latest/stable for
  a plain tag and `prerelease: true` for a `-rc.N` tag
- uploads artifacts and syncs the Homebrew tap when `HOMEBREW_TAP_TOKEN` is set
  (skipped for prereleases, so the tap stays on the latest stable)
- validates the published assets on Linux, macOS, and Windows against a real
  Jenkins — this runs for prereleases too

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
2. One intro paragraph naming the preceding stable release and the release channel
3. Stable releases and first RCs use `####` user-facing themes. Later RCs use
   `#### New in v...` followed by `#### From v...` for every earlier RC, newest first.
4. `### Full Changelog` includes `${PREV_TAG}...v${NEXT}`. Later RCs also
   include each consecutive RC comparison and the stable-to-first-RC comparison.

Inspect earlier RC notes and each consecutive tag diff before writing later RC
sections. A final stable release includes the whole RC series since the preceding
stable, grouped by theme. Never use the last RC as its full-changelog baseline.

Tone: user-facing, concrete, no internal-only noise (CI chore bumps, pure refactors without user impact). Use the channel-specific grouping above.

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

## Prerelease (soak) lane

Only when the user asks to soak a build before shipping it:

```bash
# package.json -> "version": "0.9.0-rc.1"
git commit -am "chore: release v0.9.0-rc.1"
git tag v0.9.0-rc.1 && git push origin main && git push origin v0.9.0-rc.1
```

Same workflow, same tests and asset validation; the release lands as a
prerelease, stays off `releases/latest`, and leaves the Homebrew tap untouched.
Testers opt in with `jenkins-cli update --channel prerelease`.

To ship it, cut the plain tag (`0.9.0` / `v0.9.0`) — do not flip the rc release's
prerelease flag, since the tap only syncs on a real tag build.

## Out of scope (unless user explicitly asks)

- Flipping an existing release's prerelease/latest flags by hand
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
- [ ] Release channel matches the tag shape (plain → latest/stable, `-rc.N` → prerelease)
