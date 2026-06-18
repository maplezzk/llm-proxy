#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
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
# 清除 Swift 增量构建缓存，防止 CI 漏编改动的文件
# 清除 Swift 增量缓存（保留 bun 编译产物），防止 CI 漏编
rm -rf .build/arm64-apple-macosx .build/release/LLMProxy*
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
cp "$ROOT_DIR/app/assets/app-icon.icns" "$APP/Contents/Resources/AppIcon.icns"
cp "$ROOT_DIR/app/assets/tray-icon.png" "$APP/Contents/Resources/tray-icon.png"
cp "$ROOT_DIR/app/assets/tray-icon@2x.png" "$APP/Contents/Resources/tray-icon@2x.png"
cp "$ROOT_DIR/app/assets/tray-icon@3x.png" "$APP/Contents/Resources/tray-icon@3x.png"
cp -R "$ROOT_DIR/app/Sources/en.lproj" "$APP/Contents/Resources/"
cp -R "$ROOT_DIR/app/Sources/zh.lproj" "$APP/Contents/Resources/"
cp -R "$ROOT_DIR/locales" "$APP/Contents/Resources/locales"
# 拷贝 SPM resource bundle，确保 Bundle.module 能加载资源
cp -R "$BUILD_DIR/release/LLMProxy_LLMProxy.bundle" "$APP/Contents/Resources/"

# 从 package.json 读取版本号
VERSION=$(node -p "require('$ROOT_DIR/package.json').version")

cat > "$APP/Contents/Info.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key><string>LLMProxy</string>
    <key>CFBundleIdentifier</key><string>com.maplezzk.llmproxy</string>
    <key>CFBundleName</key><string>LLMProxy</string>
    <key>CFBundleIconFile</key><string>AppIcon</string>
    <key>CFBundleVersion</key><string>${VERSION}</string>
    <key>CFBundleShortVersionString</key><string>${VERSION}</string>
    <key>LSUIElement</key><true/>
    <key>NSAppTransportSecurity</key>
    <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST

codesign --force --deep --sign - "$APP" 2>/dev/null || true

echo "=== 4. Create DMG ==="
APP_NAME="LLMProxy"
DMG="$BUILD_DIR/LLMProxy-v${VERSION}.dmg"
DMG_SRC=$(mktemp -d /tmp/llmproxy-dmg.XXXXXX)

# Build DMG source directory (app + Applications symlink for drag-to-install)
cp -R "$APP" "$DMG_SRC/$APP_NAME.app"
ln -s /Applications "$DMG_SRC/Applications"

# Create DMG
rm -f "$DMG"
hdiutil create -fs HFS+ -srcfolder "$DMG_SRC" -volname "$APP_NAME" -format UDZO -o "$DMG"

# 验证 DMG 可正常挂载
hdiutil attach "$DMG" -nobrowse -readonly -quiet
hdiutil detach "/Volumes/$APP_NAME" -quiet

# Cleanup
rm -rf "$DMG_SRC"

echo ""
echo "✅ Done"
echo "   .app: $APP ($(du -sh "$APP" | cut -f1))"
echo "   .dmg: $DMG ($(du -sh "$DMG" | cut -f1))"
