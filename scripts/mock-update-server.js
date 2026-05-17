#!/usr/bin/env node
/**
 * 本地更新测试 Mock 服务器
 *
 * 模拟 GitHub Releases API 返回，用于本地测试自动更新功能。
 *
 * 使用方式:
 *   node scripts/mock-update-server.js
 *
 * 应用端设置环境变量:
 *   LLM_PROXY_UPDATE_MOCK=http://127.0.0.1:9999
 *   或者在调试模式下自动检测此地址
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 9999;
const ROOT = path.resolve(__dirname, '..');

// 模拟的版本号（比当前版本高即可触发更新）
const MOCK_VERSION = '99.99.99';

// 生成一个测试用的 DMG 文件（实际是个文本文件，够验证流程就行）
const TEST_DMG_PATH = path.join(ROOT, '.build/test-update.dmg');
const TEST_DMG_SIZE = 5 * 1024 * 1024; // 5MB 模拟文件

function ensureTestDMG() {
  if (fs.existsSync(TEST_DMG_PATH)) return;
  const dir = path.dirname(TEST_DMG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  console.log(`[mock] Generating test DMG (${TEST_DMG_SIZE / 1024 / 1024}MB)...`);
  const buf = Buffer.alloc(TEST_DMG_SIZE, 'X');
  // 写入一段标识文本，方便验证
  buf.write(`LLMProxy Mock Update v${MOCK_VERSION} - This is a test file, not a real DMG.`);
  fs.writeFileSync(TEST_DMG_PATH, buf);
  console.log(`[mock] Test DMG ready at ${TEST_DMG_PATH}`);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  console.log(`[mock] ${req.method} ${url.pathname}`);

  // CORS 头
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // GitHub API: /repos/maplezzk/llm-proxy/releases/latest
  if (url.pathname === '/repos/maplezzk/llm-proxy/releases/latest') {
    const release = {
      tag_name: `v${MOCK_VERSION}`,
      body: `## Mock Release v${MOCK_VERSION}\n\nThis is a test release for local development.`,
      published_at: new Date().toISOString(),
      assets: [
        {
          name: `LLMProxy-v${MOCK_VERSION}.dmg`,
          browser_download_url: `http://127.0.0.1:${PORT}/download/LLMProxy-v${MOCK_VERSION}.dmg`,
          content_type: 'application/x-apple-diskimage',
        },
      ],
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(release));
    console.log(`[mock] → Released version ${MOCK_VERSION}`);
    return;
  }

  // DMG 下载
  if (url.pathname.startsWith('/download/')) {
    if (!fs.existsSync(TEST_DMG_PATH)) {
      ensureTestDMG();
    }
    const stat = fs.statSync(TEST_DMG_PATH);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="LLMProxy-v${MOCK_VERSION}.dmg"`,
    });
    const stream = fs.createReadStream(TEST_DMG_PATH);
    stream.pipe(res);

    // 模拟进度：记录下载量
    let total = 0;
    stream.on('data', (chunk) => {
      total += chunk.length;
      const pct = ((total / stat.size) * 100).toFixed(0);
      if (total % (1024 * 512) === 0) { // 每 512KB 打印一次
        console.log(`[mock] ⬇ Download progress: ${pct}% (${(total / 1024 / 1024).toFixed(1)}MB / ${(stat.size / 1024 / 1024).toFixed(1)}MB)`);
      }
    });
    stream.on('end', () => {
      console.log(`[mock] ✅ Download complete (${(total / 1024 / 1024).toFixed(1)}MB)`);
    });
    return;
  }

  // 健康检查
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

ensureTestDMG();

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║       LLMProxy 自动更新本地 Mock 服务器         ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  Mock version:  v${MOCK_VERSION}                      ║`);
  console.log(`║  Listen on:     http://127.0.0.1:${PORT}              ║`);
  console.log('║  Test DMG:      5MB 模拟文件                     ║');
  console.log('║                                                  ║');
  console.log('║  在另一个终端运行应用:                            ║');
  console.log('║    LLM_PROXY_UPDATE_MOCK=http://127.0.0.1:9999 \\ ║');
  console.log('║      swift run                                    ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');
});
