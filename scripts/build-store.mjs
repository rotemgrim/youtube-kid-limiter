// Builds the upload bundle for the Chrome Web Store:
//   dist/youtube-kid-limiter-v<version>.zip
// The zip has manifest.json at its root (required by the store) and contains
// only the runtime files.

import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
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
// adm-zip writes spec-compliant forward-slash entry paths on every OS (Linux, macOS,
// Windows), so the staged files — manifest.json at the root — land correctly for the
// Chrome Web Store without any platform-specific shelling out.
const zip = new AdmZip();
zip.addLocalFolder(staging);
zip.writeZip(zipPath);

console.log('\n✓ Store bundle ready:');
console.log(`  ${zipPath}`);
console.log('\nUpload this zip at https://chrome.google.com/webstore/devconsole');
