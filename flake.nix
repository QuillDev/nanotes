{
  description = "NaNotes - a floating Markdown scratchpad backed by local files";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.callPackage ./nix/package.nix { };
          nanotes = self.packages.${system}.default;
        });

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/nanotes";
        };
        nanotes = self.apps.${system}.default;
      });

      devShells = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              bun
              cargo
              cargo-tauri
              nodejs
              pkg-config
              rustc
              rustfmt
            ] ++ lib.optionals stdenv.hostPlatform.isLinux [
              dbus
              glib
              glib-networking
              gtk3
              libayatana-appindicator
              openssl
              webkitgtk_4_1
            ];
          };
        });
    };
}
