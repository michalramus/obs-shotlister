#!/usr/bin/env bash
# Assembles Shotlister Cue Tray.app.
#
# A raw binary can create a menu bar item, but without a bundle there is no Info.plist,
# so no LSUIElement, so macOS gives it a Dock icon and treats it as a foreground app.
set -euo pipefail

cd "$(dirname "$0")/.."

APP="target/Shotlister Cue Tray.app"
UNIVERSAL=${UNIVERSAL:-1}

if [ "$UNIVERSAL" = "1" ]; then
  rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
  cargo build --release --target aarch64-apple-darwin
  cargo build --release --target x86_64-apple-darwin
  BINARY="target/shotlister-tray-universal"
  lipo -create -output "$BINARY" \
    target/aarch64-apple-darwin/release/shotlister-tray \
    target/x86_64-apple-darwin/release/shotlister-tray
else
  cargo build --release
  BINARY="target/release/shotlister-tray"
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp macos/Info.plist "$APP/Contents/Info.plist"
cp "$BINARY" "$APP/Contents/MacOS/shotlister-tray"
chmod +x "$APP/Contents/MacOS/shotlister-tray"

# Ad-hoc signature. Enough for the bundle to launch locally; it is neither signed with a
# Developer ID nor notarised, so the first launch still needs right-click -> Open.
codesign --force --sign - "$APP"

echo "built $APP"
