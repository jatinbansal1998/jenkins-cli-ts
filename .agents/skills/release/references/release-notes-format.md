# Release notes format

Always write custom notes; do not leave only GitHub auto-generated
"What's Changed" lists.

## Skeleton

Replace placeholders:

- `NEW` — this release without `v` (e.g. `0.8.13`)
- `PREV` — previous release without `v` (e.g. `0.8.12`)
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

## Finding PREV

```bash
gh release list --limit 20
git describe --tags --abbrev=0
```
