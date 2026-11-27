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
    echo "Error: no prebuilt Linux binary for architecture '$ARCH'. Build it from source instead." >&2
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

APP_DIR="$DATA_DIR/nanotes"
mkdir -p "$INSTALL_DIR" "$DATA_DIR/applications" "$DATA_DIR/icons/hicolor/512x512/apps"
rm -rf "$APP_DIR"
cp -R "$TMP_DIR/nanotes" "$APP_DIR"
# Electron's sandbox helper needs root or unrestricted user namespaces (Ubuntu 24+ restricts
# them), so this per-user copy starts without it. The .deb package keeps the sandbox.
rm -f "$INSTALL_DIR/nanotes"
cat > "$INSTALL_DIR/nanotes" <<EOF
#!/bin/sh
exec "$APP_DIR/nanotes" --no-sandbox "\$@"
EOF
chmod 0755 "$INSTALL_DIR/nanotes"

if [ -f "$TMP_DIR/nanotes.png" ]; then
  install -m 0644 "$TMP_DIR/nanotes.png" "$DATA_DIR/icons/hicolor/512x512/apps/nanotes.png"
fi

if [ -f "$TMP_DIR/nanotes.desktop" ]; then
  sed "s|^Exec=.*|Exec=$INSTALL_DIR/nanotes|" "$TMP_DIR/nanotes.desktop" > "$DATA_DIR/applications/nanotes.desktop"
fi

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$DATA_DIR/applications" >/dev/null 2>&1 || true
fi

echo "Installed nanotes ${TAG_NAME} to $APP_DIR (command: $INSTALL_DIR/nanotes)"

case ":${PATH}:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo "Add $INSTALL_DIR to your PATH to run 'nanotes' from the terminal:"
    echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac
