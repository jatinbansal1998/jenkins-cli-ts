# Release notes format (prerelease)

Match the style of recent prereleases (e.g. `v0.7.26`). Always write custom notes;
do not leave only GitHub auto-generated "What's Changed" lists.

## Skeleton

Replace placeholders:

- `NEW` — this release without `v` (e.g. `0.7.27`)
- `PREV` — previous prerelease without `v` (e.g. `0.7.26`)
- `STABLE` — latest stable without `v` (e.g. `0.7.17`)
- `FIRST_PRE` — first prerelease after stable without `v` (e.g. `0.7.18`)
- `REPO` — `jatinbansal1998/jenkins-cli-ts` (or current origin owner/name)

```markdown
## vNEW

`vNEW` is a prerelease that brings together all changes since the latest stable release, `vSTABLE`, including the work previously published in the `vFIRST_PRE` through `vPREV` prereleases.

### New Since vPREV

#### Short Theme Title

- User-facing bullet.
- Another concrete change.

#### Another Theme

- …

### Included from vFIRST_PRE to vPREV

#### Theme From Earlier Prereleases

- Condensed bullets rolled forward from prior prerelease notes (not a full dump of every commit).

#### Another Prior Theme

- …

### Full Changelogs

- [Changes since the previous prerelease (`vPREV...vNEW`)](https://github.com/REPO/compare/vPREV...vNEW)
- [All changes since the latest stable release (`vSTABLE...vNEW`)](https://github.com/REPO/compare/vSTABLE...vNEW)
```

## Intro sentence variants

**Multiple intermediate prereleases** (common):

> `v0.7.26` is a prerelease that brings together all changes since the latest stable release, `v0.7.17`, including the work previously published in the `v0.7.18` through `v0.7.25` prereleases.

**List a few intermediates by name** when the range is short:

> … including the work previously published in the `v0.7.18`, `v0.7.19`, and `v0.7.20` prereleases.

**First prerelease after stable** (no intermediate section):

> `v0.7.18` is a prerelease that brings together all changes since the latest stable release, `v0.7.17`.

Omit `### Included from …` when there are no intermediate prereleases.

## Section guidance

### New Since vPREV

- Only work that landed between `vPREV` and `vNEW`.
- Prefer product language over commit subjects.
- Group into `####` themes (auth, watch UI, builds, etc.).
- Skip pure version-bump / lint-only noise.

### Included from vFIRST_PRE to vPREV

- Roll forward the important themes from earlier prerelease notes so a reader of **only** this prerelease still sees the full story since stable.
- Keep this section denser than "New Since"; merge related themes over time.
- Source material: previous release bodies via `gh release view vPREV --json body`.

### Full Changelogs

Always include **both** compare links when a previous prerelease and a stable baseline exist.

## Example excerpt (real shape from v0.7.26)

```markdown
## v0.7.26

`v0.7.26` is a prerelease that brings together all changes since the latest stable release, `v0.7.17`, including the work previously published in the `v0.7.18` through `v0.7.25` prereleases.

### New Since v0.7.25

#### Dual Browser Prompts During Auth Login

- Interactive login now offers to open the browser at two points in the flow.
- …

### Included from v0.7.18 to v0.7.25

#### Private, Uniform Secure-Store Accounts

- …

### Full Changelogs

- [Changes since the previous prerelease (`v0.7.25...v0.7.26`)](https://github.com/jatinbansal1998/jenkins-cli-ts/compare/v0.7.25...v0.7.26)
- [All changes since the latest stable release (`v0.7.17...v0.7.26`)](https://github.com/jatinbansal1998/jenkins-cli-ts/compare/v0.7.17...v0.7.26)
```

## Finding STABLE and PREV

```bash
# Latest releases (note Pre-release vs Latest)
gh release list --limit 30

# Explicit: latest non-prerelease
gh release list --limit 50 --json tagName,isPrerelease,isLatest \
  --jq '.[] | select(.isPrerelease == false) | .tagName' | head -1

# Previous tag for this line of work
git describe --tags --abbrev=0
```

When in doubt, open the last few prerelease bodies and copy structure, not prose.
