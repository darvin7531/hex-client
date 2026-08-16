import { createHash } from "node:crypto";
import path from "node:path";
import net from "node:net";

const WINDOWS_RESERVED = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

const PACK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const NICKNAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const SHA256_RE = /^[a-fA-F0-9]{64}$/;
const SHA1_RE = /^[a-fA-F0-9]{40}$/;


export function assertReleaseChannel(value: unknown): "stable" | "beta" | "test" {
  if (value !== "stable" && value !== "beta" && value !== "test") {
    throw new Error("Invalid release channel");
  }
  return value;
}

export function assertServerAddress(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid server address");
  let raw = value.trim();
  if (!raw || raw.length > 253 || raw.includes("\0") || /[\s\/\?#@]/.test(raw)) {
    throw new Error("Invalid server address");
  }
  if (raw.startsWith("[") && raw.endsWith("]")) raw = raw.slice(1, -1);
  if (net.isIP(raw)) return raw;
  if (raw.endsWith(".")) raw = raw.slice(0, -1);
  if (!raw || raw.length > 253) throw new Error("Invalid server address");
  const labels = raw.split(".");
  if (labels.some((label) => !label || label.length > 63 || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label))) {
    throw new Error("Invalid server address");
  }
  return raw.toLowerCase();
}

export function assertServerPort(value: unknown): number {
  const port = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid server port");
  }
  return port;
}

export function assertPackId(value: unknown): string {
  if (typeof value !== "string" || !PACK_ID_RE.test(value)) {
    throw new Error("Invalid pack id");
  }
  return value;
}

export function assertPackVersion(value: unknown, optional = false): string | undefined {
  if ((value === undefined || value === null || value === "") && optional) {
    return undefined;
  }
  if (typeof value !== "string" || !VERSION_RE.test(value)) {
    throw new Error("Invalid pack version");
  }
  return value;
}

export function assertNickname(value: unknown): string {
  if (typeof value !== "string" || !NICKNAME_RE.test(value)) {
    throw new Error("Nickname must be 3-16 characters: letters, digits or underscore");
  }
  return value;
}


export function offlineUuidFromNickname(nickname: string) {
  const safeNickname = assertNickname(nickname);
  const digest = createHash("md5").update(`OfflinePlayer:${safeNickname}`, "utf8").digest();
  digest[6] = (digest[6]! & 0x0f) | 0x30;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  return digest.toString("hex");
}

export function assertMemoryMb(value: unknown, totalMemoryMb: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error("Invalid memory amount");
  }
  const max = Math.max(2048, totalMemoryMb - (totalMemoryMb >= 12288 ? 3072 : 2048));
  if (value < 1024 || value > max) {
    throw new Error(`Memory must be between 1024 and ${max} MB`);
  }
  return value;
}

export function assertResolution(value: unknown): string {
  if (typeof value !== "string" || !/^\d{3,5}x\d{3,5}$/.test(value)) {
    throw new Error("Invalid resolution");
  }
  const [w, h] = value.split("x").map(Number);
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 640 || h < 360 || w > 16384 || h > 16384) {
    throw new Error("Resolution is outside supported bounds");
  }
  return `${w}x${h}`;
}

export function assertSha256(value: unknown, required = true): string {
  if ((!value || value === "") && !required) return "";
  if (typeof value !== "string" || !SHA256_RE.test(value)) {
    throw new Error("Invalid SHA-256");
  }
  return value.toLowerCase();
}

export function assertSha1(value: unknown, required = true): string {
  if ((!value || value === "") && !required) return "";
  if (typeof value !== "string" || !SHA1_RE.test(value)) {
    throw new Error("Invalid SHA-1");
  }
  return value.toLowerCase();
}

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
}

export function normalizeApiBase(raw: string, allowInsecureLoopback = true): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("Invalid backend URL");
  }

  if (u.username || u.password || u.search || u.hash) {
    throw new Error("Backend URL must not contain credentials, query or fragment");
  }

  if (u.protocol !== "https:" && !(allowInsecureLoopback && u.protocol === "http:" && isLoopbackHost(u.hostname))) {
    throw new Error("Backend URL must use HTTPS (HTTP is allowed only for loopback development)");
  }

  const cleanPath = u.pathname.replace(/\/+$/, "");
  if (!cleanPath.endsWith("/api")) {
    throw new Error("Backend URL must end with /api");
  }
  u.pathname = cleanPath;
  return u.toString().replace(/\/$/, "");
}

export function apiOrigin(apiBase: string): string {
  return new URL(apiBase).origin;
}

export function assertSameOriginHttpUrl(raw: string, apiBase: string): string {
  const u = new URL(raw, apiBase.replace(/\/api$/, "/"));
  const api = new URL(apiBase);
  if (u.protocol !== api.protocol || u.origin !== api.origin) {
    throw new Error(`Untrusted download origin: ${u.origin}`);
  }
  if (u.protocol !== "https:" && !isLoopbackHost(u.hostname)) {
    throw new Error("Insecure download URL");
  }
  if (u.username || u.password) {
    throw new Error("Download URL must not contain credentials");
  }
  return u.toString();
}

export function assertTrustedOfficialUrl(raw: string, allowedHosts: ReadonlySet<string>): string {
  const u = new URL(raw);
  if (u.protocol !== "https:") {
    throw new Error(`Official download must use HTTPS: ${u.href}`);
  }
  if (!allowedHosts.has(u.hostname.toLowerCase())) {
    throw new Error(`Untrusted official download host: ${u.hostname}`);
  }
  if (u.username || u.password) {
    throw new Error("URL credentials are not allowed");
  }
  return u.toString();
}

export function normalizeManagedRelativePath(input: unknown): string {
  if (typeof input !== "string" || input.length === 0 || input.length > 240) {
    throw new Error("Invalid managed file path");
  }
  if (input.includes("\\") || input.startsWith("/") || /^[A-Za-z]:/.test(input)) {
    throw new Error(`Managed path must be portable and relative: ${input}`);
  }

  const parts = input.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Unsafe managed path: ${input}`);
  }

  for (const part of parts) {
    if (part !== part.trim() || /[<>:"|?*\x00-\x1F]/.test(part) || /[. ]$/.test(part)) {
      throw new Error(`Windows-incompatible managed path: ${input}`);
    }
    const stem = part.split(".")[0]?.toLowerCase() ?? "";
    if (WINDOWS_RESERVED.has(stem)) {
      throw new Error(`Windows-reserved managed path: ${input}`);
    }
  }

  return parts.join("/");
}

export function assertSafeCacheSegment(value: unknown, label = "cache key"): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 160) {
    throw new Error(`Invalid ${label}`);
  }
  if (value !== value.trim() || value === "." || value === ".." || /[\\/:*?"<>|\x00-\x1F]/.test(value) || /[. ]$/.test(value)) {
    throw new Error(`Unsafe ${label}: ${value}`);
  }
  const stem = value.split(".")[0]?.toLowerCase() ?? "";
  if (WINDOWS_RESERVED.has(stem)) throw new Error(`Windows-reserved ${label}: ${value}`);
  return value;
}

export function assertSafeArchiveFileName(value: unknown, expectedExtension?: string): string {
  const name = assertSafeCacheSegment(value, "archive filename");
  if (path.basename(name) !== name) throw new Error(`Unsafe archive filename: ${name}`);
  if (expectedExtension && !name.toLowerCase().endsWith(expectedExtension.toLowerCase())) {
    throw new Error(`Unexpected archive extension: ${name}`);
  }
  return name;
}

export function safeJoinManaged(root: string, relative: unknown): string {
  const normalized = normalizeManagedRelativePath(relative);
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, ...normalized.split("/"));
  const prefix = `${resolvedRoot}${path.sep}`;
  if (candidate !== resolvedRoot && !candidate.startsWith(prefix)) {
    throw new Error("Managed path escaped its root");
  }
  return candidate;
}

export function assertPathWithin(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("Path is outside managed launcher storage");
  }
  return resolved;
}

export function assertSafeInstallerFileName(value: unknown, fallback: string): string {
  const raw = typeof value === "string" && value.trim() ? value.trim() : fallback;
  const base = path.basename(raw);
  if (base !== raw || base.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9._() +\-]{0,159}\.(exe|msi)$/i.test(base)) {
    throw new Error("Unsafe installer filename");
  }
  return base;
}

const SAFE_EXE_INSTALLER_ARGS = new Set([
  "/s",
  "/silent",
  "/verysilent",
  "/quiet",
  "/passive",
  "/norestart",
]);

const SAFE_MSI_INSTALLER_ARGS = new Set([
  "/quiet",
  "/passive",
  "/norestart",
  "/qn",
  "/qb",
  "/qb!",
  "/qr",
]);

export function assertSilentArgs(value: unknown, installerFileName?: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 4) {
    throw new Error("Invalid installer arguments");
  }
  return value.map((item) => {
    if (typeof item !== "string" || item.length > 32 || item.includes("\0")) {
      throw new Error("Invalid installer argument");
    }
    const normalized = item.trim();
    const extension = installerFileName ? path.extname(installerFileName).toLowerCase() : "";
    const allowed = extension === ".msi" ? SAFE_MSI_INSTALLER_ARGS : extension === ".exe" ? SAFE_EXE_INSTALLER_ARGS : null;
    if (!allowed || !allowed.has(normalized.toLowerCase())) {
      throw new Error(`Unsupported installer argument for ${extension || "unknown installer"}: ${normalized}`);
    }
    return normalized;
  });
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_RE.test(value);
}
