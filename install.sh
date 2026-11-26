#!/bin/sh
set -eu

REPO="QuillDev/nanotes"
VERSION="${1:-${NANOTES_VERSION:-}}"
INSTALL_DIR="${NANOTES_INSTALL_DIR:-$HOME/.local/bin}"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}"

OS=$(uname -s)
ARCH=$(uname -m)

if [ "$OS" != "Linux" ]; then
  echo "Error: install.sh is for Linux. Use Homebrew on macOS or install.ps1 / WinGet on Windows." >&2
  exit 1
fi

case "$ARCH" in
  x86_64|amd64)
    ASSET_SUFFIX="linux_x86_64.tar.gz"
    ;;
  *)
    echo "Error: no prebuilt Linux binary for architecture '$ARCH'. Try 'nix run github:$REPO' or build from source." >&2
    exit 1
    ;;
esac

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -H "User-Agent: nanotes-linux-installer" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- --header="User-Agent: nanotes-linux-installer" "$1"
  else
    echo "Error: curl or wget is required." >&2
    exit 1
  fi
}

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -H "User-Agent: nanotes-linux-installer" -o "$2" "$1"
  else
    wget -qO "$2" --header="User-Agent: nanotes-linux-installer" "$1"
  fi
}

if [ -z "$VERSION" ]; then
  API_URL="https://api.github.com/repos/$REPO/releases/latest"
else
  case "$VERSION" in
    v*) TAG="$VERSION" ;;
    *)  TAG="v$VERSION" ;;
  esac
  API_URL="https://api.github.com/repos/$REPO/releases/tags/$TAG"
fi

echo "Fetching release metadata from $REPO..."
RELEASE_JSON=$(fetch "$API_URL")

TAG_NAME=$(printf '%s\n' "$RELEASE_JSON" \
  | tr ',' '\n' \
  | grep -m 1 '"tag_name"' \
  | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')

DOWNLOAD_URL=$(printf '%s\n' "$RELEASE_JSON" \
  | tr ',' '\n' \
  | grep '"browser_download_url"' \
  | grep "$ASSET_SUFFIX" \
  | head -n 1 \
  | sed -E 's/.*"browser_download_url"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')

if [ -z "$DOWNLOAD_URL" ]; then
  echo "Error: no Linux release archive (*$ASSET_SUFFIX) found on release ${TAG_NAME:-unknown}." >&2
  exit 1
fi

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT INT TERM

ARCHIVE="$TMP_DIR/nanotes.tar.gz"
echo "Downloading nanotes ${TAG_NAME}..."
download "$DOWNLOAD_URL" "$ARCHIVE"

tar -xzf "$ARCHIVE" -C "$TMP_DIR"

mkdir -p "$INSTALL_DIR" "$DATA_DIR/applications" "$DATA_DIR/icons/hicolor/128x128/apps"
install -m 0755 "$TMP_DIR/nanotes" "$INSTALL_DIR/nanotes"

if [ -f "$TMP_DIR/nanotes.png" ]; then
  install -m 0644 "$TMP_DIR/nanotes.png" "$DATA_DIR/icons/hicolor/128x128/apps/nanotes.png"
fi

if [ -f "$TMP_DIR/nanotes.desktop" ]; then
  sed "s|^Exec=.*|Exec=$INSTALL_DIR/nanotes|" "$TMP_DIR/nanotes.desktop" > "$DATA_DIR/applications/nanotes.desktop"
fi

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$DATA_DIR/applications" >/dev/null 2>&1 || true
fi

echo "Installed nanotes ${TAG_NAME} to $INSTALL_DIR/nanotes"

if command -v ldd >/dev/null 2>&1; then
  MISSING=$(ldd "$INSTALL_DIR/nanotes" 2>/dev/null | grep 'not found' || true)
  if [ -n "$MISSING" ]; then
    echo "" >&2
    echo "Warning: missing runtime libraries detected:" >&2
    printf '%s\n' "$MISSING" >&2
    echo "Install WebKitGTK 4.1 (e.g. 'sudo apt install libwebkit2gtk-4.1-0' on Debian/Ubuntu, 'sudo dnf install webkit2gtk4.1' on Fedora, or 'sudo pacman -S webkit2gtk-4.1' on Arch)." >&2
  fi
fi

case ":${PATH}:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo "Add $INSTALL_DIR to your PATH to run 'nanotes' from the terminal:"
    echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac
