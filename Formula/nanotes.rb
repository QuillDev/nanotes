class Nanotes < Formula
  desc "Nako-styled floating Markdown scratchpad backed by local files"
  homepage "https://github.com/QuillDev/nanotes"
  url "https://github.com/QuillDev/nanotes/archive/refs/tags/v0.1.0.tar.gz"
  # Replace with the real checksum after pushing the v0.1.0 tag:
  #   brew fetch --build-from-source ./Formula/nanotes.rb   # prints the sha256
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  license "MIT"
  head "https://github.com/QuillDev/nanotes.git", branch: "main"

  depends_on "node" => :build
  depends_on "rust" => :build
  depends_on :macos

  def install
    # Build the React/Vite frontend with npm so the install does not require
    # bun (which isn't in homebrew-core). This produces ../dist.
    system "npm", "install", *std_npm_args(prefix: false)
    system "npm", "run", "build"

    # Bundle the macOS .app with the Tauri CLI. The project's beforeBuildCommand
    # shells out to bun, so blank it here — the frontend is already built above.
    # --bundles app keeps this to the .app (no .dmg/codesign step).
    system "./node_modules/.bin/tauri", "build",
           "--bundles", "app",
           "--config", '{"build":{"beforeBuildCommand":""}}'

    prefix.install "src-tauri/target/release/bundle/macos/NaNotes.app"
  end

  def caveats
    <<~EOS
      NaNotes is installed as a macOS .app inside the Homebrew prefix. To launch
      it from Spotlight or Launchpad, link it into your Applications folder:

        ln -sf "#{opt_prefix}/NaNotes.app" /Applications/NaNotes.app

      Then press Cmd+Shift+N to toggle the overlay from any app. Open settings
      (Cmd+O) to enable "Launch at login".
    EOS
  end

  test do
    assert_path_exists prefix/"NaNotes.app/Contents/MacOS/NaNotes"
  end
end
