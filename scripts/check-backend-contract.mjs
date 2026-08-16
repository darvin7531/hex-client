const requiredCapabilities = new Set([
  'fabric', 'forge', 'neoforge',
  'release_channels', 'release_channel_snapshots', 'version_selection', 'artifact_policies',
  'server_bootstrap', 'server_override', 'server_motd', 'quick_play_multiplayer',
  'launcher_updates', 'signed_manifests', 'maintenance_notices',
]);

const safeExeInstallerArgs = new Set(['/s', '/silent', '/verysilent', '/quiet', '/passive', '/norestart']);
const safeMsiInstallerArgs = new Set(['/quiet', '/passive', '/norestart', '/qn', '/qb', '/qb!', '/qr']);
const requiredStates = new Set(['not_installed', 'installing', 'update_available', 'updating', 'repair_required', 'ready_to_launch', 'launching', 'running', 'launch_failed']);

const argIndex = process.argv.indexOf('--url');
const rawBase = argIndex >= 0 ? process.argv[argIndex + 1] : (process.env.HEXLOADER_API_BASE || 'http://127.0.0.1:4000/api');
if (!rawBase) throw new Error('Missing backend URL');
const base = rawBase.replace(/\/+$/, '');
const baseUrl = new URL(base);
if (baseUrl.protocol !== 'https:' && !['127.0.0.1', 'localhost', '::1'].includes(baseUrl.hostname)) {
  throw new Error('Backend contract checker refuses non-HTTPS remote URLs');
}

async function get(path, { allow404 = false } = {}) {
  const response = await fetch(`${base}${path}`, { redirect: 'error', headers: { 'User-Agent': 'HexLoader-contract-check' } });
  if (allow404 && response.status === 404) return null;
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > 32 * 1024 * 1024) throw new Error(`${path}: response too large`);
  try { return JSON.parse(text); } catch { throw new Error(`${path}: invalid JSON`); }
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: expected object`);
  return value;
}
function string(value, label, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new Error(`${label}: expected string`);
  return value;
}
function bool(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label}: expected boolean`);
  return value;
}
function integer(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label}: expected integer ${min}..${max}`);
  return value;
}
function array(value, label, max = 10000) {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label}: expected bounded array`);
  return value;
}

function checkRelease(raw, expectedPack, expectedVersion) {
  const release = object(raw, `release ${expectedPack}@${expectedVersion}`);
  if (string(release.packId, 'release.packId') !== expectedPack) throw new Error('release.packId mismatch');
  if (string(release.packVersion, 'release.packVersion') !== expectedVersion) throw new Error('release.packVersion mismatch');
  if (!['stable', 'beta', 'test'].includes(string(release.releaseChannel, 'release.releaseChannel'))) throw new Error('invalid release channel');
  if (!['Fabric', 'Forge', 'NeoForge'].includes(string(release.loaderType, 'release.loaderType'))) throw new Error('invalid loader type');
  string(release.minecraftVersion, 'release.minecraftVersion');
  string(release.loaderVersion, 'release.loaderVersion');

  const java = object(release.javaRequirements, 'javaRequirements');
  const major = integer(java.majorVersion, 'javaRequirements.majorVersion', 8, 99);
  if (string(java.os, 'javaRequirements.os').toLowerCase() !== 'windows') throw new Error('backend must target Windows');
  if (string(java.arch, 'javaRequirements.arch').toLowerCase() !== 'x64') throw new Error('backend must target x64');
  if (string(java.runtimePackageId, 'javaRequirements.runtimePackageId') !== `temurin-${major}-win-x64`) throw new Error('runtimePackageId mismatch');

  const server = object(release.serverBootstrap, 'serverBootstrap');
  string(server.serverName, 'serverBootstrap.serverName');
  string(server.serverAddress, 'serverBootstrap.serverAddress');
  integer(server.serverPort, 'serverBootstrap.serverPort', 1, 65535);
  bool(server.autoConnect, 'serverBootstrap.autoConnect');
  bool(server.allowUserOverride, 'serverBootstrap.allowUserOverride');
  string(server.motd, 'serverBootstrap.motd', true);

  const seen = new Set();
  for (const [index, fileRaw] of array(release.files, 'release.files', 50000).entries()) {
    const file = object(fileRaw, `release.files[${index}]`);
    const path = string(file.path, `release.files[${index}].path`);
    const key = path.toLowerCase();
    if (seen.has(key)) throw new Error(`duplicate file path: ${path}`);
    seen.add(key);
    integer(file.size, `release.files[${index}].size`, 0, Number.MAX_SAFE_INTEGER);
    if (!/^[a-f0-9]{64}$/i.test(string(file.sha256, `release.files[${index}].sha256`))) throw new Error(`invalid file SHA-256: ${path}`);
    const sourceUrl = new URL(string(file.sourceUrl, `release.files[${index}].sourceUrl`), baseUrl.origin);
    if (sourceUrl.origin !== baseUrl.origin) throw new Error(`cross-origin artifact URL: ${path}`);
    string(file.kind, `release.files[${index}].kind`);
    const policy = string(file.updatePolicy, `release.files[${index}].updatePolicy`);
    if (!['required_replace', 'required_keep_if_same', 'optional'].includes(policy)) throw new Error(`invalid updatePolicy: ${policy}`);
    const required = bool(file.required, `release.files[${index}].required`);
    if ((policy === 'optional') === required) throw new Error(`required/updatePolicy mismatch: ${path}`);
    bool(file.preserveUserChanges, `release.files[${index}].preserveUserChanges`);
    if ('executable' in file) throw new Error(`obsolete executable artifact field leaked into launcher contract: ${path}`);
  }
  array(release.changelog, 'release.changelog', 1000);
  const stateMachine = new Set(array(release.stateMachine, 'release.stateMachine', 128).map((state) => string(state, 'stateMachine state')));
  const missingStates = [...requiredStates].filter((state) => !stateMachine.has(state));
  if (missingStates.length) throw new Error(`release stateMachine missing: ${missingStates.join(', ')}`);
  array(release.diagnostics, 'release.diagnostics', 256);
  string(release.manifestHash, 'release.manifestHash');
  string(release.signature, 'release.signature', true);
  return release;
}

const version = object(await get('/launcher/version'), 'launcher version');
if (!/^2(?:\.|$)/.test(string(version.backendApiVersion, 'backendApiVersion'))) throw new Error(`unsupported backend API ${version.backendApiVersion}`);
const capabilities = new Set(array(version.capabilities, 'capabilities', 128).map((item) => string(item, 'capability')));
const missing = [...requiredCapabilities].filter((capability) => !capabilities.has(capability));
if (missing.length) throw new Error(`backend missing capabilities: ${missing.join(', ')}`);
bool(version.maintenanceMode, 'maintenanceMode');

const notices = await get('/notices');
array(notices, 'notices', 200);
const packs = array(await get('/packs'), 'packs', 128);
let checkedReleases = 0;
for (const [packIndex, packRaw] of packs.entries()) {
  const pack = object(packRaw, `packs[${packIndex}]`);
  const packId = string(pack.packId, `packs[${packIndex}].packId`);
  const channel = string(pack.releaseChannel, `packs[${packIndex}].releaseChannel`);
  if (!['stable', 'beta', 'test'].includes(channel)) throw new Error(`${packId}: invalid channel`);
  const latestVersion = string(pack.latestVersion, `${packId}.latestVersion`);
  const versions = array(await get(`/packs/${encodeURIComponent(packId)}/versions?includeArchived=true`), `${packId}.versions`, 512).map((raw, index) => {
    const version = object(raw, `${packId}.versions[${index}]`);
    const releaseChannel = string(version.releaseChannel, `${packId}.versions[${index}].releaseChannel`);
    if (!['stable', 'beta', 'test'].includes(releaseChannel)) throw new Error(`${packId}: invalid version channel ${releaseChannel}`);
    return {
      packVersion: string(version.packVersion, `${packId}.versions[${index}].packVersion`),
      releaseChannel,
    };
  });
  if (!versions.some((item) => item.packVersion === latestVersion)) throw new Error(`${packId}: latestVersion is absent from /versions`);

  const latest = checkRelease(await get(`/packs/${encodeURIComponent(packId)}/latest?channel=${encodeURIComponent(channel)}`), packId, latestVersion);
  if (latest.releaseChannel !== channel) throw new Error(`${packId}: latest channel mismatch`);
  checkedReleases += 1;

  for (const releaseVersion of versions.slice(0, 50)) {
    const release = checkRelease(
      await get(`/packs/${encodeURIComponent(packId)}/releases/${encodeURIComponent(releaseVersion.packVersion)}?channel=${encodeURIComponent(releaseVersion.releaseChannel)}`),
      packId,
      releaseVersion.packVersion,
    );
    if (release.releaseChannel !== releaseVersion.releaseChannel) throw new Error(`${packId}@${releaseVersion.packVersion}: version channel mismatch`);
    checkedReleases += 1;
  }
}

const updater = await get('/launcher/update?platform=win32', { allow404: true });
if (updater) {
  const update = object(updater, 'launcher update');
  string(update.version, 'launcher update.version');
  const fileName = string(update.fileName, 'launcher update.fileName');
  if (!/\.(exe|msi)$/i.test(fileName)) throw new Error('launcher update file must be .exe or .msi');
  const installerUrl = new URL(string(update.installerUrl, 'launcher update.installerUrl'), baseUrl.origin);
  if (installerUrl.origin !== baseUrl.origin) throw new Error('launcher update installer must be same-origin');
  if (!/^[a-f0-9]{64}$/i.test(string(update.sha256, 'launcher update.sha256'))) throw new Error('launcher update SHA-256 is invalid');
  const silentArgs = array(update.silentArgs, 'launcher update.silentArgs', 4).map((arg, index) => string(arg, `launcher update.silentArgs[${index}]`));
  const installerArgs = /\.msi$/i.test(fileName) ? safeMsiInstallerArgs : safeExeInstallerArgs;
  for (const arg of silentArgs) if (!installerArgs.has(arg.trim().toLowerCase())) throw new Error(`unsupported launcher installer argument for ${fileName}: ${arg}`);
  bool(update.mandatory, 'launcher update.mandatory');
  if (string(update.platform, 'launcher update.platform') !== 'win32') throw new Error('launcher update platform mismatch');
}

console.log(`HexLoader backend contract OK: API ${version.backendApiVersion}, ${packs.length} packs, ${checkedReleases} release responses checked.`);
