import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const failures = [];

function parseVersion(value) {
  const match = String(value).match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function atLeast(actual, expected) {
  for (let i = 0; i < 3; i++) {
    if (actual[i] > expected[i]) return true;
    if (actual[i] < expected[i]) return false;
  }
  return true;
}

const nodeVersion = parseVersion(process.versions.node);
if (!nodeVersion || nodeVersion[0] !== 24 || !atLeast(nodeVersion, [24, 18, 1])) {
  failures.push(`Node ${process.versions.node} is unsupported; use Node 24.18.1 or newer Node 24.x.`);
}

let npmText = '';
try {
  const npmExecPath = process.env.npm_execpath;
  npmText = npmExecPath
    ? execFileSync(process.execPath, [npmExecPath, '--version'], { encoding: 'utf8' }).trim()
    : execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version'], { encoding: 'utf8' }).trim();
} catch {
  failures.push('npm is unavailable; install npm 12.0.1 or newer npm 12.x.');
}
const npmVersion = parseVersion(npmText);
if (npmText && (!npmVersion || npmVersion[0] !== 12 || !atLeast(npmVersion, [12, 0, 1]))) {
  failures.push(`npm ${npmText} is unsupported; use npm 12.0.1 or newer npm 12.x.`);
}

const expected = { ...pkg.dependencies, ...pkg.devDependencies };
for (const [name, wanted] of Object.entries(expected)) {
  if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(wanted)) {
    failures.push(`${name} must be pinned to an exact version, found ${wanted}`);
    continue;
  }

  const parts = name.startsWith('@') ? name.split('/') : [name];
  const packageJson = path.join(root, 'node_modules', ...parts, 'package.json');
  try {
    const installed = JSON.parse(fs.readFileSync(packageJson, 'utf8')).version;
    if (installed !== wanted) failures.push(`${name}: installed ${installed}, expected ${wanted}`);
  } catch {
    failures.push(`${name}: not installed; run npm install`);
  }
}

for (const removed of ['framer-motion', '@types/adm-zip']) {
  if (expected[removed]) failures.push(`${removed} should not be present in package.json`);
}

if (failures.length) {
  console.error('\nToolchain/dependency check failed:\n');
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}

console.log(`Toolchain OK: Node ${process.versions.node}; npm ${npmText}; ${Object.keys(expected).length} direct dependencies pinned exactly.`);
