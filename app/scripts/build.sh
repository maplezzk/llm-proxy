#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$ROOT_DIR/app/.build"

echo "=== 1. Build llm-proxy binary ==="
cd "$ROOT_DIR"
npm run build
npx esbuild src/index.ts --bundle --platform=node --outfile=dist/bundle.js --format=esm
ARCH="$(uname -m)"
[ "$ARCH" = "arm64" ] && TARGET="aarch64-apple-darwin" || TARGET="x86_64-apple-darwin"
bun build --compile --target "bun-$TARGET" ./dist/bundle.js --outfile "$BUILD_DIR/llm-proxy"
chmod +x "$BUILD_DIR/llm-proxy"
cp dist/api/admin-ui.html "$BUILD_DIR/admin-ui.html"
cp dist/api/admin-app.js "$BUILD_DIR/admin-app.js"

echo "=== 2. Build Swift app ==="
cd "$ROOT_DIR/app"
swift build -c release

echo "=== 3. Package .app ==="
APP="$BUILD_DIR/LLMProxy.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
mkdir -p "$APP/Contents/Resources"

cp "$BUILD_DIR/release/LLMProxy" "$APP/Contents/MacOS/"
cp "$BUILD_DIR/llm-proxy" "$APP/Contents/Resources/"
cp "$BUILD_DIR/admin-ui.html" "$APP/Contents/Resources/"
cp "$BUILD_DIR/admin-app.js" "$APP/Contents/Resources/"
[ -f "$ROOT_DIR/app/assets/app-icon.icns" ] && cp "$ROOT_DIR/app/assets/app-icon.icns" "$APP/Contents/Resources/AppIcon.icns"
[ -f "$ROOT_DIR/app/assets/menubar-icon.icns" ] && cp "$ROOT_DIR/app/assets/menubar-icon.icns" "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key><string>LLMProxy</string>
    <key>CFBundleIdentifier</key><string>com.maplezzk.llm-proxy</string>
    <key>CFBundleName</key><string>LLMProxy</string>
    <key>CFBundleVersion</key><string>1.0</string>
    <key>CFBundleShortVersionString</key><string>1.0</string>
    <key>LSUIElement</key><true/>
    <key>NSAppTransportSecurity</key>
    <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST

codesign --force --deep --sign - "$APP" 2>/dev/null || true

echo "=== 4. Create DMG ==="
DMG="$BUILD_DIR/LLMProxy.dmg"
rm -f "$DMG"
hdiutil create -fs HFS+ -srcfolder "$APP" -volname "LLMProxy" "$DMG" 2>/dev/null

echo ""
echo "✅ Done"
echo "   .app: $APP ($(du -sh "$APP" | cut -f1))"
echo "   .dmg: $DMG ($(du -sh "$DMG" | cut -f1))"
