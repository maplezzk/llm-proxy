#!/bin/bash
APP=/Applications/LLMProxyMenuBar.app
mkdir -p "$APP/Contents/MacOS"
mkdir -p "$APP/Contents/Resources"
cp .build/release/LLMProxyMenuBar "$APP/Contents/MacOS/"
cat > "$APP/Contents/Info.plist" << 'PLIST'
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
    <string>1.0</string>
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
echo "安装完成: $APP"
echo "添加到登录项: 系统设置 → 通用 → 登录项，添加 LLMProxyMenuBar.app"
