// Bumps the extension version by one patch level, keeping manifest.json, package.json
// and package-lock.json in lockstep. manifest.json is the source of truth — the new
// version is derived from it. Prints the new version on stdout so CI can capture it.
//
//   node scripts/bump-version.mjs   ->   1.0.1  (and writes the three files)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
// Preserve trailing newline and 2-space indentation so diffs stay minimal.
const writeJson = (p, obj) => writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');

const manifestPath = path.join(ROOT, 'manifest.json');
const pkgPath = path.join(ROOT, 'package.json');
const lockPath = path.join(ROOT, 'package-lock.json');

const manifest = readJson(manifestPath);
const [major, minor, patch] = String(manifest.version).split('.').map((n) => parseInt(n, 10) || 0);
const next = `${major}.${minor}.${patch + 1}`;

manifest.version = next;
writeJson(manifestPath, manifest);

const pkg = readJson(pkgPath);
pkg.version = next;
writeJson(pkgPath, pkg);

if (existsSync(lockPath)) {
  const lock = readJson(lockPath);
  lock.version = next;
  if (lock.packages && lock.packages['']) lock.packages[''].version = next;
  writeJson(lockPath, lock);
}

// Bare version on stdout for `$(node scripts/bump-version.mjs)` capture in CI.
process.stdout.write(next + '\n');
