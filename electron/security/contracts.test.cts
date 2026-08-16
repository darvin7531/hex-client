import test from "node:test";
import assert from "node:assert/strict";
import { parseLauncherVersion, parsePackRelease, parsePackSummaries, parsePackVersions } from "./contracts.cjs";

function releaseFixture() {
  return {
    packId: "classic",
    packName: "Classic",
    packVersion: "1.0.0",
    archived: false,
    releaseChannel: "stable",
    minecraftVersion: "1.21.1",
    loaderType: "Fabric",
    loaderVersion: "0.16.10",
    javaRequirements: {
      majorVersion: 21,
      vendor: "Temurin",
      arch: "x64",
      os: "windows",
      runtimePackageId: "temurin-21-win-x64",
      sha256: "",
    },
    serverBootstrap: {
      serverName: "Hex",
      serverAddress: "play.example.test",
      serverPort: 25565,
      autoConnect: true,
      allowUserOverride: false,
      motd: "Private server",
    },
    files: [{
      path: "mods/example.jar",
      size: 123,
      sha256: "a".repeat(64),
      sourceUrl: "https://launcher.example.test/storage/packs/classic/1.0.0/mods/example.jar",
      kind: "mod",
      updatePolicy: "required_replace",
      required: true,
      preserveUserChanges: false,
    }],
    changelog: [],
    publishedAt: "2026-08-11T00:00:00Z",
    manifestHash: "classic-1.0.0",
    signature: "",
    stateMachine: ["not_installed", "installing", "installed", "update_available", "updating", "repair_required", "ready_to_launch", "launching", "running", "launch_failed"],
    diagnostics: [],
  };
}

test("release contract accepts a bounded Windows x64 manifest", () => {
  const parsed = parsePackRelease(releaseFixture());
  assert.equal(parsed.packId, "classic");
  assert.equal(parsed.files[0]?.path, "mods/example.jar");
});

test("release contract rejects case-insensitive path collisions", () => {
  const value = releaseFixture();
  value.files.push({ ...value.files[0]!, path: "Mods/Example.jar" });
  assert.throws(() => parsePackRelease(value), /Duplicate managed path/);
});

test("release contract rejects unsupported runtime targets", () => {
  const value = releaseFixture();
  value.javaRequirements.os = "linux";
  assert.throws(() => parsePackRelease(value), /Unsupported runtime target/);
});

test("pack list rejects duplicate ids ignoring case", () => {
  const base = {
    packId: "classic",
    packName: "Classic",
    description: "",
    releaseChannel: "stable",
    latestVersion: "1.0.0",
    minecraftVersion: "1.21.1",
    loaderType: "Fabric",
    loaderVersion: "0.16.10",
    javaVersion: 21,
    heroTitle: "Classic",
    heroSubtitle: "",
  };
  assert.throws(() => parsePackSummaries([base, { ...base, packId: "CLASSIC" }]), /Duplicate pack id/);
});


test("launcher version requires the backend capability contract", () => {
  const parsed = parseLauncherVersion({
    currentVersion: "0.3.0",
    minimumSupportedBackend: "0.1.0",
    maintenanceMode: false,
    backendApiVersion: "2.0.0",
    capabilities: [
      "fabric", "forge", "neoforge", "release_channels", "release_channel_snapshots", "version_selection", "artifact_policies",
      "server_bootstrap", "server_override", "server_motd", "quick_play_multiplayer",
      "launcher_updates", "signed_manifests", "maintenance_notices",
    ],
  });
  assert.equal(parsed.backendApiVersion, "2.0.0");
  assert.throws(() => parseLauncherVersion({ ...parsed, capabilities: ["fabric"] }), /missing required launcher capabilities/i);
});

test("version list contract accepts published version summaries", () => {
  const parsed = parsePackVersions([{ packId: "classic", packVersion: "1.2.3", releaseChannel: "beta", archived: false, publishedAt: "2026-08-12T00:00:00Z" }]);
  assert.equal(parsed[0]?.packVersion, "1.2.3");
  assert.equal(parsed[0]?.releaseChannel, "beta");
});


test("release contract rejects incoherent optional required flag", () => {
  const release = releaseFixture();
  release.files[0] = { ...release.files[0], updatePolicy: "optional", required: true };
  assert.throws(() => parsePackRelease(release), /Optional file must have required=false/);
});
