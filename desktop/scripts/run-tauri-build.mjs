#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const defaultKeyPath = path.join(process.env.HOME || process.env.USERPROFILE || '', '.tauri', 'airouter-updater.key');
const keyPath = process.env.TAURI_SIGNING_PRIVATE_KEY_PATH || defaultKeyPath;

if (!process.env.TAURI_SIGNING_PRIVATE_KEY && keyPath && fs.existsSync(keyPath)) {
  process.env.TAURI_SIGNING_PRIVATE_KEY = fs.readFileSync(keyPath, 'utf8');
}

if (!process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
  process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = '';
}

const isWindows = process.platform === 'win32';
const command = isWindows ? 'npx.cmd' : 'npx';
const result = spawnSync(command, ['tauri', 'build', ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: isWindows,
});

if (result.error) {
  console.error(`Failed to start Tauri build command (${command}): ${result.error.message}`);
}

process.exit(result.status ?? 1);
