# Homebrew Distribution

This project currently ships Homebrew using the Bun-script artifact (`dist/jenkins-cli`)
and a formula that depends on `bun`.

## User install

```bash
brew tap jatinbansal1998/tap
brew install jatinbansal1998/tap/jenkins-cli
```

## Tap repository setup (one time)

1. Create a GitHub repository named `homebrew-tap`.
2. Add GitHub Actions repository secret `HOMEBREW_TAP_TOKEN` in
   `jatinbansal1998/jenkins-cli-ts`.
3. Use a fine-grained token with:
   - `Contents: Read and write` on `jatinbansal1998/homebrew-tap`
   - `Metadata: Read`
4. Ensure tap default branch is `main`.

After this, each new `v*` tag release auto-syncs `Formula/jenkins-cli.rb` to the
tap via `gh repo clone` in `.github/workflows/release.yml`.

Users can install with `brew install jatinbansal1998/tap/jenkins-cli`.

## Release flow

The release workflow (`.github/workflows/release.yml`) uploads these assets for each
tagged release:

- `jenkins-cli`
- `jenkins-cli.sha256`
- `homebrew-jenkins-cli.rb`

If `HOMEBREW_TAP_TOKEN` is set, the workflow automatically commits the formula to
`jatinbansal1998/homebrew-tap`.

If release logs show:

`remote: Permission to jatinbansal1998/homebrew-tap.git denied ... (403)`

then the token is valid for GitHub auth but does not have write access to the tap.
Recreate `HOMEBREW_TAP_TOKEN` as a fine-grained token scoped to
`jatinbansal1998/homebrew-tap` with `Contents: Read and write`.

Manual fallback (if token is missing or sync fails):

```bash
TAG=v0.5.0
gh repo clone jatinbansal1998/homebrew-tap -- --depth 1
cd homebrew-tap
curl -fsSL \
  -o Formula/jenkins-cli.rb \
  "https://github.com/jatinbansal1998/jenkins-cli-ts/releases/download/${TAG}/homebrew-jenkins-cli.rb"
git add Formula/jenkins-cli.rb
git commit -m "jenkins-cli ${TAG}"
git push origin HEAD:main
```

## Local validation

In tap repo:

```bash
brew audit --strict --online Formula/jenkins-cli.rb
brew install --build-from-source Formula/jenkins-cli.rb
brew test jenkins-cli
```
