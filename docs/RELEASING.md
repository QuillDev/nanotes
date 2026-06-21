# Releasing NaNotes

NaNotes ships as a build-from-source Homebrew formula. Users run
`brew install quilldev/tap/nanotes`, which compiles the app locally. To make that
command work you need two public GitHub repositories:

1. **`QuillDev/nanotes`** — this source repository (provides the release tarball).
2. **`QuillDev/homebrew-tap`** — the Homebrew tap that hosts the formula.

The canonical formula lives in this repo at [`Formula/nanotes.rb`](../Formula/nanotes.rb);
the tap repo holds a copy of it.

## Cutting a release

1. Bump the version in `package.json`, `src-tauri/Cargo.toml`, and
   `src-tauri/tauri.conf.json`, then commit.

2. Tag and push the source repo:

   ```bash
   git tag v0.1.0
   git push origin main --tags
   ```

3. Get the checksum of the GitHub-generated source tarball and update the formula:

   ```bash
   curl -sL https://github.com/QuillDev/nanotes/archive/refs/tags/v0.1.0.tar.gz \
     | shasum -a 256
   ```

   Put that value in `Formula/nanotes.rb` (replacing the placeholder `sha256`),
   and make sure `url` points at the new tag.

4. Verify the formula builds and passes audit before publishing:

   ```bash
   brew audit --formula ./Formula/nanotes.rb
   brew install --build-from-source ./Formula/nanotes.rb
   ```

## Publishing the tap (first time)

```bash
# Create the tap repo with the standard layout.
brew tap-new QuillDev/tap
cp Formula/nanotes.rb "$(brew --repository QuillDev/tap)/Formula/nanotes.rb"

# Push it to github.com/QuillDev/homebrew-tap (the repo must be named
# "homebrew-tap" so `brew install QuillDev/tap/...` resolves it).
cd "$(brew --repository QuillDev/tap)"
gh repo create QuillDev/homebrew-tap --public --source=. --push
```

On later releases, just copy the updated `Formula/nanotes.rb` into the tap repo
and push.

## Verifying a published install

```bash
brew untap quilldev/tap 2>/dev/null || true   # drop any local copy
brew install quilldev/tap/nanotes
```
