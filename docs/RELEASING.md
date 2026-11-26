# Releasing NaNotes

NaNotes builds prebuilt release binaries for macOS (Apple Silicon and Intel), Windows (x64), and Linux (x86_64) in parallel via `.github/workflows/release.yml`. The workflow only runs when cutting a release (`v*` tag push or manual `workflow_dispatch`), keeping pull requests fast.

## Cutting a release

1. Bump the version in `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, and `nix/package.nix`, then commit and merge to `main`.

2. Tag and push:

   ```bash
   git tag v0.3.5
   git push origin main --tags
   ```

   You can also attach release builds to an existing tag from the GitHub Actions UI via **Release -> Run workflow** with the tag name (or leave the tag blank for a build-only check).

3. The `Release` workflow builds all four targets in parallel and uploads the assets plus `SHA256SUMS.txt` to the GitHub Release:
   - macOS Apple Silicon: `NaNotes_<version>_aarch64.app.tar.gz` (ad-hoc signed)
   - macOS Intel: `NaNotes_<version>_x64.app.tar.gz` (ad-hoc signed)
   - Windows x64: `NaNotes_<version>_x64-setup.exe` (NSIS installer)
   - Linux x86_64: `nanotes_<version>_linux_x86_64.tar.gz` (used by `install.sh`) and `.deb`

## Automatic package manager updates

The `publish` job automatically updates downstream package managers when the corresponding repository secrets are configured in `QuillDev/nanotes` (and skips cleanly without failing the release when they are not):

### Homebrew tap (`QuillDev/homebrew-tap`)

Add a GitHub PAT with write access to `QuillDev/homebrew-tap` as the `HOMEBREW_TAP_TOKEN` Actions secret. On every release, the workflow updates `Casks/nanotes.rb` with the new version and macOS arm64/x64 SHA256 checksums (and removes the legacy source `Formula/nanotes.rb` if present). Without the secret, the workflow prints the generated `Casks/nanotes.rb` in the run summary for manual copying.

### WinGet (`microsoft/winget-pkgs`)

`winget-releaser` updates existing packages in `microsoft/winget-pkgs`, so the very first version needs a one-time submission after a GitHub Release has the Windows installer attached:

```bash
komac new QuillDev.nanotes \
  --version <version> \
  --urls https://github.com/QuillDev/nanotes/releases/download/v<version>/NaNotes_<version>_x64-setup.exe \
  --submit
```

To automate future WinGet updates on every `v*` release tag, fork `microsoft/winget-pkgs` under `QuillDev` and add a GitHub PAT with `public_repo` scope as the `WINGET_TOKEN` Actions secret in `QuillDev/nanotes`.
