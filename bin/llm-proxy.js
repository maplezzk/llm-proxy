#!/usr/bin/env node
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { spawn } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const srcEntry = resolve(__dirname, '../src/index.ts')

const tsx = resolve(__dirname, '../node_modules/.bin/tsx')

const child = spawn(tsx, [srcEntry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
})

child.on('exit', (code) => process.exit(code ?? 0))
