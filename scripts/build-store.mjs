// Builds the upload bundle for the Chrome Web Store:
//   dist/youtube-kid-limiter-v<version>.zip
// The zip has manifest.json at its root (required by the store) and contains
// only the runtime files.

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { ROOT, readManifest, stageTo } from './stage.mjs';

const manifest = readManifest();
const version = manifest.version;
const staging = path.join(ROOT, 'build', 'staging');
const distDir = path.join(ROOT, 'dist');
const zipPath = path.join(distDir, `youtube-kid-limiter-v${version}.zip`);

console.log(`Staging runtime files for v${version}...`);
stageTo(staging);

mkdirSync(distDir, { recursive: true });
rmSync(zipPath, { force: true });

console.log(`Zipping -> ${path.relative(ROOT, zipPath)}`);
if (process.platform === 'win32') {
  // Compress the *contents* of staging so manifest.json lands at the zip root.
  execFileSync(
    'powershell',
    ['-NoProfile', '-Command',
      `Compress-Archive -Path '${path.join(staging, '*')}' -DestinationPath '${zipPath}' -Force`],
    { stdio: 'inherit' },
  );
} else {
  // zip CLI: -r recurse, '.' so paths are relative to the staging root.
  execFileSync('zip', ['-r', '-q', zipPath, '.'], { cwd: staging, stdio: 'inherit' });
}

console.log('\n✓ Store bundle ready:');
console.log(`  ${zipPath}`);
console.log('\nUpload this zip at https://chrome.google.com/webstore/devconsole');
