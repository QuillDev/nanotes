{
  lib,
  stdenv,
  rustPlatform,
  cargo-tauri,
  dbus,
  glib-networking,
  libayatana-appindicator,
  nodejs,
  importNpmLock,
  openssl,
  pkg-config,
  webkitgtk_4_1,
  wrapGAppsHook4,
}:

rustPlatform.buildRustPackage rec {
  pname = "nanotes";
  version = "0.3.1";

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../assets
      ../index.html
      ../nix
      ../package.json
      ../package-lock.json
      ../src
      ../src-tauri
      ../tsconfig.json
      ../vite.config.ts
    ];
  };

  cargoRoot = "src-tauri";
  buildAndTestSubdir = "src-tauri";

  cargoHash = "sha256-I+Gy+6yVvP+JIieVeJxunFM/JmtGv1H1QCPwWI3YMls=";
  npmDeps = importNpmLock { npmRoot = src; };

  postPatch = lib.optionalString stdenv.hostPlatform.isLinux ''
    substituteInPlace src-tauri/tauri.conf.json \
      --replace-fail '"beforeDevCommand": "bun run dev:web"' '"beforeDevCommand": "npm run dev:web"' \
      --replace-fail '"beforeBuildCommand": "bun run build"' '"beforeBuildCommand": "npm run build"'

    substituteInPlace $cargoDepsCopy/*/libappindicator-sys-*/src/lib.rs \
      --replace-fail "libayatana-appindicator3.so.1" "${libayatana-appindicator}/lib/libayatana-appindicator3.so.1"
  '';

  nativeBuildInputs = [
    cargo-tauri.hook
    nodejs
    importNpmLock.npmConfigHook
    pkg-config
    rustPlatform.cargoSetupHook
  ] ++ lib.optionals stdenv.hostPlatform.isLinux [
    wrapGAppsHook4
  ];

  buildInputs = lib.optionals stdenv.hostPlatform.isLinux [
    dbus
    glib-networking
    libayatana-appindicator
    openssl
    webkitgtk_4_1
  ];

  meta = {
    description = "A Nako-styled floating Markdown scratchpad backed by local files";
    homepage = "https://github.com/QuillDev/nanotes";
    license = lib.licenses.mit;
    mainProgram = "nanotes";
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
}
