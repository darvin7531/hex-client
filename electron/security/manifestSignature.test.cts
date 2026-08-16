import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import type { PackRelease } from "./contracts.cjs";
import { computeCanonicalManifestDigest, verifyManifestIntegrity } from "./manifestSignature.cjs";

function fixture(): PackRelease {
  return {
    packId: "test-pack",
    packName: "Test Pack",
    packVersion: "1.0.0",
    archived: false,
    releaseChannel: "stable",
    minecraftVersion: "1.21.1",
    loaderType: "Fabric",
    loaderVersion: "0.16.10",
    javaRequirements: {
      majorVersion: 21,
      vendor: "Eclipse Adoptium",
      arch: "x64",
      os: "windows",
      runtimePackageId: "temurin-21-win-x64",
      sha256: "",
    },
    serverBootstrap: {
      serverName: "Test",
      serverAddress: "127.0.0.1",
      serverPort: 25565,
      autoConnect: false,
      allowUserOverride: false,
      motd: "Private server",
    },
    files: [{
      path: "mods/example.jar",
      size: 123,
      sha256: "a".repeat(64),
      sourceUrl: "https://launcher.example.com/storage/packs/example.jar",
      kind: "mod",
      updatePolicy: "required_replace",
      required: true,
      preserveUserChanges: false,
    }],
    changelog: ["Initial"],
    publishedAt: "2026-08-11T00:00:00Z",
    manifestHash: "",
    signature: "",
    stateMachine: ["not_installed", "installing", "installed", "update_available", "updating", "repair_required", "ready_to_launch", "launching", "running", "launch_failed"],
    diagnostics: [],
  };
}

test("signed manifest verifies and tampering fails", () => {
  const release = fixture();
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const rawPublicKey = spki.subarray(spki.length - 32);
  const digest = computeCanonicalManifestDigest(release);
  release.manifestHash = digest.toString("hex");
  release.signature = sign(null, digest, privateKey).toString("base64");

  assert.deepEqual(
    verifyManifestIntegrity(release, rawPublicKey.toString("base64"), true),
    { mode: "signed", verified: true },
  );

  release.files[0].size += 1;
  assert.throws(() => verifyManifestIntegrity(release, rawPublicKey.toString("base64"), true));
});

test("legacy manifest is accepted only as compatibility mode", () => {
  const release = fixture();
  release.manifestHash = `${release.packId}-${release.packVersion}`;
  assert.deepEqual(verifyManifestIntegrity(release, "", false), { mode: "legacy", verified: false });
  assert.throws(() => verifyManifestIntegrity(release, "", true));
});


test("canonical manifest digest matches the Go backend fixture", () => {
  const release: PackRelease = {
    packId: "classic",
    packName: "Classic",
    packVersion: "1.2.3",
    archived: false,
    releaseChannel: "beta",
    minecraftVersion: "1.21.1",
    loaderType: "Forge",
    loaderVersion: "52.1.0",
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
      allowUserOverride: true,
      motd: "Hello",
    },
    files: [{
      path: "mods/a.jar",
      size: 123,
      sha256: "a".repeat(64),
      sourceUrl: "https://launcher.example.test/storage/packs/classic/1.2.3/mods/a.jar",
      kind: "mod",
      updatePolicy: "optional",
      required: false,
      preserveUserChanges: false,
    }],
    changelog: ["A"],
    publishedAt: "2026-08-12T12:34:56.000000000Z",
    manifestHash: "",
    signature: "",
    stateMachine: ["not_installed", "installing", "update_available", "updating", "repair_required", "ready_to_launch", "launching", "running", "launch_failed"],
    diagnostics: ["sha256"],
  };

  assert.equal(
    computeCanonicalManifestDigest(release).toString("hex"),
    "8882bf8a53f4e3ace1f284b47a40cad8ed263164a9e7052a04404e19825f91ee",
  );
});
