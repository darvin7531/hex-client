/**
 * Shared launcher configuration.
 *
 * Production builds should point DEFAULT_API_BASE at the real HTTPS backend.
 * Plain HTTP is accepted only for localhost/loopback development.
 */
export const DEFAULT_API_BASE = "https://95.165.141.148:24443/api";

/**
 * Set to the base64 Ed25519 public key printed by:
 *   hex-backend keygen-signing
 * Then enable HEXLOADER_MANIFEST_HASH_MODE=sha256 and the signing private key
 * on the backend. Once a key is pinned here, unsigned manifests are rejected.
 */
export const MANIFEST_SIGNING_PUBLIC_KEY_BASE64 = "xp0a1AQHxQOaHiEPa1QR6KrWK8CkkEnd7wjAtYeqRsQ=";

/**
 * If true, the launcher refuses to run unless MANIFEST_SIGNING_PUBLIC_KEY_BASE64
 * is configured and every release has a valid Ed25519 signature.
 */
export const REQUIRE_SIGNED_MANIFESTS = true;

/**
 * Production clients should keep this false. A custom backend can still be
 * supplied explicitly by the process environment HEXLOADER_API_BASE.
 */
export const ALLOW_CUSTOM_API_IN_PRODUCTION = false;

/**
 * Optional SHA-256 fingerprint of the Windows Authenticode signing certificate
 * used for HexLoader installers (64 hex characters, no separators). When set,
 * every downloaded .exe/.msi must have a Valid signature from this certificate.
 */
export const INSTALLER_SIGNER_CERT_SHA256 = "";

/**
 * Set true only after INSTALLER_SIGNER_CERT_SHA256 is pinned in the build.
 * Keeping this false preserves development compatibility with unsigned installers.
 */
export const REQUIRE_AUTHENTICODE_INSTALLER = false;
