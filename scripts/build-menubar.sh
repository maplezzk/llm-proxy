#!/bin/bash
set -euo pipefail

APP_NAME="LLMProxyMenuBar"
VERSION="${1:-$(node -p "require('./package.json').version")}"

echo "Building $APP_NAME v$VERSION..."

# Build
cd menubar
swift build -c release --arch arm64
swift build -c release --arch x86_64

# Create universal binary
mkdir -p .build/universal
lipo -create \
  .build/arm64-apple-macosx/release/$APP_NAME \
  .build/x86_64-apple-macosx/release/$APP_NAME \
  -output .build/universal/$APP_NAME

# Package as .app bundle
APP_BUNDLE=".build/$APP_NAME.app"
rm -rf "$APP_BUNDLE"
mkdir -p "$APP_BUNDLE/Contents/MacOS"
mkdir -p "$APP_BUNDLE/Contents/Resources"

cp .build/universal/$APP_NAME "$APP_BUNDLE/Contents/MacOS/"

# Copy icon
if [ -f assets/menubar-icon.icns ]; then
  cp assets/menubar-icon.icns "$APP_BUNDLE/Contents/Resources/"
fi

cat > "$APP_BUNDLE/Contents/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>LLMProxyMenuBar</string>
    <key>CFBundleIdentifier</key>
    <string>com.llmproxy.menubar</string>
    <key>CFBundleName</key>
    <string>LLMProxyMenuBar</string>
    <key>CFBundleVersion</key>
    <string>VERSION_PLACEHOLDER</string>
    <key>CFBundleShortVersionString</key>
    <string>VERSION_PLACEHOLDER</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSAppTransportSecurity</key>
    <dict>
        <key>NSAllowsLocalNetworking</key>
        <true/>
    </dict>
</dict>
</plist>
PLIST

# Replace version placeholder
sed -i '' "s/VERSION_PLACEHOLDER/$VERSION/g" "$APP_BUNDLE/Contents/Info.plist"

# Sign (ad-hoc)
codesign --force --deep --sign - "$APP_BUNDLE"

# Zip
cd .build
zip -r "$APP_NAME-v$VERSION.zip" "$APP_NAME.app"
cd ..

echo "Done: menubar/.build/$APP_NAME-v$VERSION.zip"
echo "SHA256: $(shasum -a 256 .build/$APP_NAME-v$VERSION.zip | cut -d' ' -f1)"
