// Builds a single self-contained Windows installer:
//   dist/KidLimiter-Setup.exe
//
// The .exe is a self-extracting package (built with IExpress, which ships with
// every Windows). When the recipient double-clicks it, it:
//   1. drops the packed extension (extension.crx) into %LOCALAPPDATA%\YouTubeKidLimiter
//   2. writes a local update.xml pointing at that crx
//   3. sets the per-user Chrome policy ExtensionInstallForcelist (no admin needed)
// Then they reopen Chrome and the extension is force-installed (and locked on).
//
// Requirements (build machine, Windows only):
//   - IExpress (built into Windows) to make the self-extracting .exe
//   The .crx itself is packed in pure Node (no Chrome needed).
//
// Notes:
//   - key.pem (project root) is the signing key. It fixes the extension ID and is
//     generated on first run. KEEP IT — losing it changes the ID and breaks updates.
//   - Local file:// force-install works on most Chrome builds but some hardened/
//     managed setups block it. To host the crx on a URL instead, set
//     KIDLIMITER_UPDATE_URL to your hosted update.xml URL before building.

import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, copyFileSync,
} from 'node:fs';
import {
  createHash, createPublicKey, createSign, generateKeyPairSync,
} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { ROOT, readManifest, stageTo } from './stage.mjs';

if (process.platform !== 'win32') {
  console.error('The installer build is Windows-only (it uses Chrome + IExpress).');
  process.exit(1);
}

const manifest = readManifest();
const version = manifest.version;
const buildDir = path.join(ROOT, 'build');
const staging = path.join(buildDir, 'installer-ext');
const payload = path.join(buildDir, 'installer-payload'); // files IExpress will bundle
const distDir = path.join(ROOT, 'dist');
// The signing key must live OUTSIDE the extension folder — Chrome warns if a
// key.pem sits inside a folder loaded unpacked. Default to a user-level location;
// override with KIDLIMITER_KEY if you keep it elsewhere.
const keyPath = process.env.KIDLIMITER_KEY
  || path.join(os.homedir(), '.youtube-kid-limiter', 'key.pem');
const exePath = path.join(distDir, 'KidLimiter-Setup.exe');

// ---- 1. signing key (stable extension ID) ----
if (!existsSync(keyPath)) {
  console.log(`No key found at ${keyPath} — generating a new signing key (keep it!).`);
  mkdirSync(path.dirname(keyPath), { recursive: true });
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  // Chrome's --pack-extension-key requires a PKCS#8-format PEM RSA key.
  writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
}

// Derive the Chrome extension ID from the public key (sha256 of the DER SPKI,
// first 16 bytes mapped to a-p). Matches the ID Chrome assigns when packing.
function extensionId(privatePem) {
  const der = createPublicKey(privatePem).export({ type: 'spki', format: 'der' });
  const hash = createHash('sha256').update(der).digest();
  let id = '';
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (hash[i] >> 4));
    id += String.fromCharCode(97 + (hash[i] & 0x0f));
  }
  return id;
}
const id = extensionId(readFileSync(keyPath, 'utf8'));
console.log(`Extension ID: ${id}`);

// ---- 2. pack the crx ourselves (no Chrome needed) ----
// A CRX3 file is: magic "Cr24" + version(3) + headerLength + CrxFileHeader proto
// + the extension zip. We build all of it from the key with node:crypto, so the
// build runs anywhere (including headless CI) without spawning a browser.

console.log('Staging extension files...');
stageTo(staging);

// Zip the staging dir contents (manifest.json at the zip root).
const zipForCrx = path.join(buildDir, 'installer-ext.zip');
rmSync(zipForCrx, { force: true });
if (process.platform === 'win32') {
  execFileSync('powershell', ['-NoProfile', '-Command',
    `Compress-Archive -Path '${path.join(staging, '*')}' -DestinationPath '${zipForCrx}' -Force`,
  ], { stdio: 'pipe' });
} else {
  execFileSync('zip', ['-r', '-q', zipForCrx, '.'], { cwd: staging, stdio: 'pipe' });
}
const zipBytes = readFileSync(zipForCrx);

// --- minimal protobuf writers (varint + length-delimited fields) ---
function varint(n) {
  const out = [];
  while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n);
  return Buffer.from(out);
}
// field tag = (fieldNumber << 3) | wireType; wireType 2 = length-delimited.
function lenField(fieldNumber, buf) {
  return Buffer.concat([varint((fieldNumber << 3) | 2), varint(buf.length), buf]);
}

const privatePem = readFileSync(keyPath, 'utf8');
const publicKeyDer = createPublicKey(privatePem).export({ type: 'spki', format: 'der' });

// CRX3 signs SHA256("CRX3 SignedData\0" + len(signedHeader) + signedHeader + zip).
// signedHeader is a SignedData proto: field 1 = crx_id (first 16 bytes of the
// sha256 of the public key DER).
const crxId = createHash('sha256').update(publicKeyDer).digest().subarray(0, 16);
const signedHeaderData = lenField(1, crxId);

const signedHeaderLen = Buffer.alloc(4);
signedHeaderLen.writeUInt32LE(signedHeaderData.length, 0);

const signer = createSign('sha256');
signer.update(Buffer.from('CRX3 SignedData\0', 'binary'));
signer.update(signedHeaderLen);
signer.update(signedHeaderData);
signer.update(zipBytes);
const signature = signer.sign(privatePem);

// AsymmetricKeyProof proto: field 1 = public_key, field 2 = signature.
const proof = Buffer.concat([lenField(1, publicKeyDer), lenField(2, signature)]);
// CrxFileHeader proto: field 2 = sha256_with_rsa (repeated AsymmetricKeyProof),
// field 10000 = signed_header_data (the SignedData bytes).
const header = Buffer.concat([lenField(2, proof), lenField(10000, signedHeaderData)]);

const magic = Buffer.from('Cr24', 'binary');
const ver = Buffer.alloc(4); ver.writeUInt32LE(3, 0);
const headerLen = Buffer.alloc(4); headerLen.writeUInt32LE(header.length, 0);

const producedCrx = path.join(buildDir, 'installer-ext.crx');
writeFileSync(producedCrx, Buffer.concat([magic, ver, headerLen, header, zipBytes]));
console.log(`Packed .crx (${(zipBytes.length / 1024).toFixed(0)} KB extension).`);

// ---- 3. assemble the IExpress payload (crx + install scripts) ----
rmSync(payload, { recursive: true, force: true });
mkdirSync(payload, { recursive: true });
copyFileSync(producedCrx, path.join(payload, 'extension.crx'));

// Where the crx/update.xml end up + which update URL the policy points at.
const hostedUrl = process.env.KIDLIMITER_UPDATE_URL || null;

// PowerShell installer that runs on the recipient's machine.
const installPs1 = `$ErrorActionPreference = 'Stop'
$target = Join-Path $env:LOCALAPPDATA 'YouTubeKidLimiter'
New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item -Force (Join-Path $PSScriptRoot 'extension.crx') (Join-Path $target 'extension.crx')

$crxUrl = 'file:///' + (($target -replace '\\\\','/')) + '/extension.crx'
$xml = @"
<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='${id}'>
    <updatecheck codebase='$crxUrl' version='${version}' />
  </app>
</gupdate>
"@
Set-Content -Path (Join-Path $target 'update.xml') -Value $xml -Encoding UTF8

${hostedUrl
    ? `$updateUrl = '${hostedUrl}'`
    : `$updateUrl = 'file:///' + (($target -replace '\\\\','/')) + '/update.xml'`}

$key = 'HKCU:\\Software\\Policies\\Google\\Chrome\\ExtensionInstallForcelist'
New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name '1' -Value ('${id};' + $updateUrl)

Write-Host ''
Write-Host 'YouTube Kid Limiter installed. Close and reopen Chrome to finish.'
`;
writeFileSync(path.join(payload, 'install.ps1'), installPs1);

// Thin .cmd shim that IExpress launches, which runs the PowerShell installer.
writeFileSync(
  path.join(payload, 'install.cmd'),
  '@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"\r\n',
);

// ---- 4. wrap into a self-extracting .exe with IExpress ----
mkdirSync(distDir, { recursive: true });
rmSync(exePath, { force: true });

const sedPath = path.join(buildDir, 'installer.sed');
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
InstallPrompt=Install YouTube Kid Limiter into Chrome?
DisplayLicense=
FinishMessage=Done! Close and reopen Chrome to finish installing YouTube Kid Limiter.
TargetName=${exePath}
FriendlyName=YouTube Kid Limiter Setup
AppLaunched=cmd /c install.cmd
PostInstallCmd=<None>
AdminQuietInstCmd=
UserQuietInstCmd=
FILE0="install.cmd"
FILE1="install.ps1"
FILE2="extension.crx"
[SourceFiles]
SourceFiles0=${payload}
[SourceFiles0]
%FILE0%=
%FILE1%=
%FILE2%=
`;
writeFileSync(sedPath, sed);

console.log('Building self-extracting .exe with IExpress...');
execFileSync('iexpress', ['/N', '/Q', sedPath], { stdio: 'inherit' });

if (!existsSync(exePath)) {
  console.error('IExpress did not produce the .exe. Check the output above.');
  process.exit(1);
}

console.log('\n✓ Installer ready:');
console.log(`  ${exePath}`);
console.log('\nSend this single file. The recipient double-clicks it, then reopens Chrome.');
if (!hostedUrl) {
  console.log('\nNote: this installer self-hosts the crx locally (file://). If Chrome on a');
  console.log('target machine refuses a local force-install, rebuild with a hosted update.xml:');
  console.log('  $env:KIDLIMITER_UPDATE_URL="https://you.example/update.xml"; npm run build:installer');
}
