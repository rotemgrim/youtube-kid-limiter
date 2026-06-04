// Builds a Windows self-extracting installer (dist/KidLimiter-Setup.exe) that
// FORCE-INSTALLS the extension from the Chrome Web Store and LOCKS it on, so a
// kid can't disable or remove it.
//
// Why the Web Store (and not a local .crx)?
//   Since Chrome 75, a *self-hosted* (off-store) extension can only be force-
//   installed on a MANAGED device (domain-joined / cloud-enrolled). On a normal
//   consumer PC, Chrome reads the policy but silently refuses to install it —
//   which is why the old local-file installer "did nothing".
//   A *Web Store* extension, by contrast, force-installs fine via an ordinary
//   per-user (HKCU) policy on unmanaged machines. So the extension must be
//   published to the Web Store first; this installer then just points the
//   ExtensionInstallForcelist policy at that published ID.
//
// Prerequisite: publish the extension (run `npm run build:store`, upload the zip
// at https://chrome.google.com/webstore/devconsole — an "Unlisted" listing keeps
// it private). Copy the assigned 32-char extension ID, then build the installer:
//
//   Windows:        set KIDLIMITER_WEBSTORE_ID=abcdefghijklmnopabcdefghijklmnop && npm run build:installer
//   PowerShell:     $env:KIDLIMITER_WEBSTORE_ID="abcd...mnop"; npm run build:installer
//
// The resulting .exe is what you hand to other parents — they double-click it,
// reopen Chrome, and the limiter installs itself and stays locked on.

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, readManifest } from './stage.mjs';

// Chrome's hosted-extension update service. Force-listing "<id>;<this-url>" tells
// Chrome to fetch and pin the extension from the Web Store.
const WEBSTORE_UPDATE_URL = 'https://clients2.google.com/service/update2/crx';

// A published Web Store ID is exactly 32 chars, lowercase a–p.
const EXT_ID = (process.env.KIDLIMITER_WEBSTORE_ID || '').trim().toLowerCase();
const ID_RE = /^[a-p]{32}$/;

if (!ID_RE.test(EXT_ID)) {
  console.error(
    'ERROR: a published Chrome Web Store extension ID is required.\n\n' +
    'Set it before building, e.g.:\n' +
    '  PowerShell:  $env:KIDLIMITER_WEBSTORE_ID="<32-char-id>"; npm run build:installer\n' +
    '  cmd.exe:     set KIDLIMITER_WEBSTORE_ID=<32-char-id> && npm run build:installer\n\n' +
    'You get the ID after uploading dist/*.zip (npm run build:store) at\n' +
    'https://chrome.google.com/webstore/devconsole (an "Unlisted" listing stays private).\n',
  );
  process.exit(1);
}

if (process.platform !== 'win32') {
  console.error('ERROR: the .exe is built with Windows IExpress; run this on Windows.');
  process.exit(1);
}

const manifest = readManifest();
const version = manifest.version;
const build = path.join(ROOT, 'build', 'installer');
const distDir = path.join(ROOT, 'dist');
const exePath = path.join(distDir, 'KidLimiter-Setup.exe');

rmSync(build, { recursive: true, force: true });
mkdirSync(build, { recursive: true });
mkdirSync(distDir, { recursive: true });

// --- the script that actually applies the policy on the target machine ---
// Force-install + lock: ExtensionInstallForcelist makes Chrome install the
// extension and disables the "remove"/"disable" controls for it.
const forceValue = `${EXT_ID};${WEBSTORE_UPDATE_URL}`;
const installPs1 = `# Installs YouTube Kid Limiter v${version} from the Chrome Web Store and locks it on.
$ErrorActionPreference = 'Stop'
$key = 'HKCU:\\Software\\Policies\\Google\\Chrome\\ExtensionInstallForcelist'
New-Item -Path $key -Force | Out-Null

# Find the next free numeric slot so we don't clobber an existing forced extension.
$existing = (Get-Item -Path $key).Property
$slot = 1
while ($existing -contains "$slot") { $slot++ }

Set-ItemProperty -Path $key -Name "$slot" -Value '${forceValue}'

Write-Host ''
Write-Host 'YouTube Kid Limiter is installed and locked on.' -ForegroundColor Green
Write-Host 'Close and reopen Chrome; the brain icon appears within a minute.'
Write-Host ''
`;
writeFileSync(path.join(build, 'install.ps1'), installPs1, 'utf8');

// Bootstrap that IExpress runs. Launch the PS1 elevated-per-user (HKCU needs no
// admin) and keep the window long enough to read the result.
const installCmd = `@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
pause
`;
writeFileSync(path.join(build, 'install.cmd'), installCmd, 'utf8');

// --- IExpress SED config: bundle the two scripts into one self-extracting exe ---
const sed = `[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=0
HideExtractAnimation=1
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=%InstallPrompt%
DisplayLicense=%DisplayLicense%
FinishMessage=%FinishMessage%
TargetName=%TargetName%
FriendlyName=%FriendlyName%
AppLaunched=%AppLaunched%
PostInstallCmd=%PostInstallCmd%
AdminQuietInstCmd=%AdminQuietInstCmd%
UserQuietInstCmd=%UserQuietInstCmd%
SourceFiles=SourceFiles
[Strings]
InstallPrompt=
DisplayLicense=
FinishMessage=
TargetName=${exePath}
FriendlyName=YouTube Kid Limiter Setup
AppLaunched=cmd /c install.cmd
PostInstallCmd=<None>
AdminQuietInstCmd=
UserQuietInstCmd=
FILE0="install.cmd"
FILE1="install.ps1"
[SourceFiles]
SourceFiles0=${build}\\
[SourceFiles0]
%FILE0%=
%FILE1%=
`;
const sedPath = path.join(build, 'kidlimiter.sed');
writeFileSync(sedPath, sed, 'utf8');

rmSync(exePath, { force: true });
console.log(`Building installer for v${version} (Web Store ID ${EXT_ID})...`);
execFileSync('iexpress', ['/N', '/Q', sedPath], { stdio: 'inherit' });

console.log('\n\u2713 Installer ready:');
console.log(`  ${exePath}`);
console.log('\nHand this .exe to a parent. They double-click it, reopen Chrome, and');
console.log('the limiter installs from the Web Store and stays locked on.');
