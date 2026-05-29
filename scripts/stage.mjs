// Shared helper: copies only the extension's runtime files into a clean staging
// directory, so both the store zip and the installer crx ship the same payload
// (no dev files, scripts, package.json, etc.).

import { cpSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Files/dirs that make up the shipped extension. Everything else stays out.
export const RUNTIME_ENTRIES = [
  'manifest.json',
  'background.js',
  'content',
  'popup',
  'lib',
  'icons',
];

export function readManifest() {
  return JSON.parse(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
}

// Copy the runtime entries into `destDir` (which is wiped first).
export function stageTo(destDir) {
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  for (const entry of RUNTIME_ENTRIES) {
    const src = path.join(ROOT, entry);
    if (!existsSync(src)) throw new Error(`Missing runtime entry: ${entry}`);
    cpSync(src, path.join(destDir, entry), { recursive: true });
  }
  return destDir;
}
