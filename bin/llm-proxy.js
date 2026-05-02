#!/usr/bin/env node
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { spawn } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const entry = resolve(__dirname, '../dist/index.js')

const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
})

child.on('exit', (code) => process.exit(code ?? 0))
