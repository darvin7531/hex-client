import { createHash, createPublicKey, verify } from "node:crypto";
import type { PackRelease } from "./contracts.cjs";

function canonicalReleaseForSigning(release: PackRelease) {
  return {
    packId: release.packId,
    packName: release.packName,
    packVersion: release.packVersion,
    archived: release.archived,
    releaseChannel: release.releaseChannel,
    minecraftVersion: release.minecraftVersion,
    loaderType: release.loaderType,
    loaderVersion: release.loaderVersion,
    javaRequirements: {
      majorVersion: release.javaRequirements.majorVersion,
      ...(release.javaRequirements.vendor ? { vendor: release.javaRequirements.vendor } : {}),
      arch: release.javaRequirements.arch,
      os: release.javaRequirements.os,
      runtimePackageId: release.javaRequirements.runtimePackageId,
      sha256: release.javaRequirements.sha256,
    },
    serverBootstrap: {
      serverName: release.serverBootstrap.serverName,
      serverAddress: release.serverBootstrap.serverAddress,
      serverPort: release.serverBootstrap.serverPort,
      autoConnect: release.serverBootstrap.autoConnect,
      allowUserOverride: release.serverBootstrap.allowUserOverride,
      motd: release.serverBootstrap.motd,
    },
    files: release.files.map((file) => ({
      path: file.path,
      size: file.size,
      sha256: file.sha256,
      sourceUrl: file.sourceUrl,
      kind: file.kind,
      updatePolicy: file.updatePolicy,
      required: file.required,
      preserveUserChanges: file.preserveUserChanges,
    })),
    changelog: release.changelog,
    publishedAt: release.publishedAt,
    manifestHash: "",
    signature: "",
    stateMachine: release.stateMachine,
    diagnostics: release.diagnostics,
  };
}

export function computeCanonicalManifestDigest(release: PackRelease): Buffer {
  return createHash("sha256")
    .update(JSON.stringify(canonicalReleaseForSigning(release)), "utf8")
    .digest();
}

function ed25519RawPublicKeyToKeyObject(raw: Buffer) {
  if (raw.length !== 32) throw new Error("Manifest signing public key must be 32 bytes");
  // SubjectPublicKeyInfo prefix for Ed25519 (OID 1.3.101.112).
  const prefix = Buffer.from("302a300506032b6570032100", "hex");
  return createPublicKey({ key: Buffer.concat([prefix, raw]), format: "der", type: "spki" });
}

export function verifyManifestIntegrity(
  release: PackRelease,
  publicKeyBase64: string,
  requireSigned: boolean,
): { mode: "signed" | "sha256" | "legacy"; verified: boolean } {
  const digest = computeCanonicalManifestDigest(release);
  const digestHex = digest.toString("hex");
  const hasSha256ManifestHash = /^[a-f0-9]{64}$/i.test(release.manifestHash);

  if (hasSha256ManifestHash && release.manifestHash.toLowerCase() !== digestHex) {
    throw new Error("Manifest hash mismatch");
  }

  if (publicKeyBase64.trim()) {
    if (!hasSha256ManifestHash || !release.signature) {
      throw new Error("Signed manifest required but backend returned no signature");
    }
    const publicKey = ed25519RawPublicKeyToKeyObject(Buffer.from(publicKeyBase64, "base64"));
    const signature = Buffer.from(release.signature, "base64");
    if (signature.length !== 64 || !verify(null, digest, publicKey, signature)) {
      throw new Error("Manifest Ed25519 signature verification failed");
    }
    return { mode: "signed", verified: true };
  }

  if (requireSigned) {
    throw new Error("Manifest signing is required but no pinned public key is configured");
  }

  if (hasSha256ManifestHash) {
    return { mode: "sha256", verified: true };
  }

  const expectedLegacy = `${release.packId}-${release.packVersion}`;
  if (release.manifestHash !== expectedLegacy) {
    throw new Error("Unrecognized legacy manifest hash");
  }
  return { mode: "legacy", verified: false };
}
