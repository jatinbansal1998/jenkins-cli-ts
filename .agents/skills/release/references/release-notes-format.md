# Release notes format

Always write custom notes; do not leave only GitHub auto-generated
"What's Changed" lists.

## Stable release skeleton

Replace placeholders:

- `NEW` — this release without `v` (e.g. `0.8.13`)
- `PREV` — previous stable release without `v` (e.g. `0.8.12`)
- `REPO` — `jatinbansal1998/jenkins-cli-ts` (or current origin owner/name)

```markdown
## vNEW

`vNEW` is the latest stable release, covering everything that landed since `vPREV`.

#### Short Theme Title

- User-facing bullet.
- Another concrete change.

#### Another Theme

- …

### Full Changelog

- [All changes since `vPREV`](https://github.com/REPO/compare/vPREV...vNEW)
```

## Section guidance

- Only work that landed between `vPREV` and `vNEW`.
- Prefer product language over commit subjects.
- Group into `####` themes (auth, watch UI, builds, logs, etc.).
- Skip pure version-bump / lint-only noise.
- If a release carries no user-facing change (e.g. a re-cut after a bad tag), say
  so in one line instead of padding the notes.

## Example excerpt (real shape from v0.8.11)

```markdown
## v0.8.11

`v0.8.11` is the latest stable release, covering everything that landed since `v0.8.10`.

#### Cleaner, Searchable Build Logs

- `logs --plain` strips ANSI sequences, concealed Jenkins metadata, and Pipeline framing while preserving visible text such as OSC hyperlink labels.
- `--no-timestamps` recognizes both ISO-8601 and `[HH:mm:ss]` prefixes; `--grep` accepts JavaScript regular expressions, and `--context` includes surrounding lines.

#### Reliable Build History Pagination

- History pages use Jenkins offset ranges with a lookahead entry, while still recovering when a controller or proxy ignores the requested range.

### Full Changelog

- [All changes since `v0.8.10`](https://github.com/jatinbansal1998/jenkins-cli-ts/compare/v0.8.10...v0.8.11)
```

## Prerelease notes

Find the stable release preceding this version's RC series using published releases
and tag ancestry. Do not use today's latest stable when correcting historical notes.
Read earlier RC bodies and check each section against its own tag diff. Include only
changes present in the target tag, never changes from a later RC.

- First RC: use the theme skeleton above, but call it the first prerelease toward
  the intended stable version. Its baseline is the preceding stable release.
- Later RCs: use release sections, newest first, as in `v0.8.14-rc.4`. Retain every
  earlier RC's changes under its own heading. Do not flatten them into themes or
  describe only the latest increment. Themes may be subheadings within an RC.
- Final stable: return to theme grouping and include all changes since the preceding
  stable release, including the entire RC series.

Example for the second RC:

```markdown
## v0.8.15-rc.2

`v0.8.15-rc.2` continues the `v0.8.15` soak, covering everything since stable
`v0.8.14`. Opt in with `jenkins-cli update --channel prerelease`.

#### New in `v0.8.15-rc.2`

- Changes introduced between rc.1 and rc.2, including output contract changes.

#### From `v0.8.15-rc.1`

- Changes introduced between the preceding stable release and rc.1.

### Full Changelog

- [`v0.8.15-rc.1` → `v0.8.15-rc.2`](https://github.com/jatinbansal1998/jenkins-cli-ts/compare/v0.8.15-rc.1...v0.8.15-rc.2)
- [`v0.8.14` → `v0.8.15-rc.1`](https://github.com/jatinbansal1998/jenkins-cli-ts/compare/v0.8.14...v0.8.15-rc.1)
- [All changes since stable `v0.8.14`](https://github.com/jatinbansal1998/jenkins-cli-ts/compare/v0.8.14...v0.8.15-rc.2)
```

For more RCs, include every consecutive published RC comparison in descending order,
then stable-to-first-RC, then the cumulative stable-to-target comparison.

Before publishing, verify that each earlier RC has a section, each claim belongs to
that section's tag range, and all comparison endpoints exist. Read back the published
body after editing. Keep the prerelease flag and stable channel unchanged when fixing
notes only.
