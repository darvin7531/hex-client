import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const configText = fs.readFileSync(path.join(root, 'electron', 'sharedConfig.cts'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function stringConst(name) {
  const match = configText.match(new RegExp(`export\\s+const\\s+${name}\\s*=\\s*["']([^"']*)["']`));
  if (!match) throw new Error(`Cannot read ${name} from electron/sharedConfig.cts`);
  return match[1];
}

function boolConst(name) {
  const match = configText.match(new RegExp(`export\\s+const\\s+${name}\\s*=\\s*(true|false)`));
  if (!match) throw new Error(`Cannot read ${name} from electron/sharedConfig.cts`);
  return match[1] === 'true';
}

const failures = [];
const warnings = [];
const electronVersion = String(pkg.devDependencies?.electron ?? '');
const electronMatch = electronVersion.match(/^(\d+)\.(\d+)\.(\d+)$/);
const electronMajor = electronMatch ? Number(electronMatch[1]) : NaN;
if (!Number.isInteger(electronMajor) || electronMajor < 43) {
  failures.push(`Electron ${electronVersion || 'unknown'} is not accepted for production. Pin a current supported stable release.`);
}

const installedElectronPackage = path.join(root, 'node_modules', 'electron', 'package.json');
try {
  const installedElectron = JSON.parse(fs.readFileSync(installedElectronPackage, 'utf8')).version;
  if (installedElectron !== electronVersion) {
    failures.push(`Installed Electron ${installedElectron} does not match pinned ${electronVersion}. Run npm install.`);
  }
} catch {
  failures.push('Electron is not installed. Run npm install before production build.');
}

const apiBase = stringConst('DEFAULT_API_BASE');
try {
  const url = new URL(apiBase);
  if (url.protocol !== 'https:' || url.pathname.replace(/\/+$/, '') !== '/api' || url.username || url.password || url.search || url.hash) {
    failures.push('DEFAULT_API_BASE must be a clean production HTTPS URL ending in /api.');
  }
  if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)) {
    failures.push('DEFAULT_API_BASE still points to loopback.');
  }
} catch {
  failures.push('DEFAULT_API_BASE is not a valid URL.');
}

if (boolConst('ALLOW_CUSTOM_API_IN_PRODUCTION')) {
  failures.push('ALLOW_CUSTOM_API_IN_PRODUCTION must be false for the normal production build.');
}

const manifestKey = stringConst('MANIFEST_SIGNING_PUBLIC_KEY_BASE64');
if (!boolConst('REQUIRE_SIGNED_MANIFESTS')) {
  failures.push('REQUIRE_SIGNED_MANIFESTS must be true for production.');
}
try {
  const raw = Buffer.from(manifestKey, 'base64');
  if (!manifestKey || raw.length !== 32 || raw.toString('base64').replace(/=+$/, '') !== manifestKey.replace(/=+$/, '')) {
    failures.push('MANIFEST_SIGNING_PUBLIC_KEY_BASE64 must contain the pinned 32-byte Ed25519 public key.');
  }
} catch {
  failures.push('MANIFEST_SIGNING_PUBLIC_KEY_BASE64 is invalid base64.');
}

const cert = stringConst('INSTALLER_SIGNER_CERT_SHA256').replace(/[^a-fA-F0-9]/g, '');
if (!boolConst('REQUIRE_AUTHENTICODE_INSTALLER')) {
  failures.push('REQUIRE_AUTHENTICODE_INSTALLER must be true for a production build with self-update enabled.');
}
if (!/^[a-fA-F0-9]{64}$/.test(cert)) {
  failures.push('INSTALLER_SIGNER_CERT_SHA256 must pin the production Authenticode certificate SHA-256 fingerprint.');
}

if (warnings.length) {
  for (const warning of warnings) console.warn(`WARN: ${warning}`);
}
if (failures.length) {
  console.error('\nProduction release gate failed:\n');
  for (const failure of failures) console.error(` - ${failure}`);
  console.error('\nUse `npm run dist:dev` only for local/test installers.');
  process.exit(1);
}

console.log(`Production release gate passed (Electron ${electronVersion}, signed manifests, pinned installer certificate).`);
