import net from "node:net";
import { assertServerAddress, assertServerPort } from "./validation.cjs";

function numericMinecraftParts(version: string): number[] {
  const match = version.trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return [];
  return match.slice(1).filter((part): part is string => part !== undefined).map(Number);
}

export function supportsQuickPlayMultiplayer(minecraftVersion: string): boolean {
  const parts = numericMinecraftParts(minecraftVersion);
  if (!parts.length) return true; // New/unknown schemes should prefer the current Mojang argument.
  const [major = 0, minor = 0] = parts;
  if (major > 1) return true; // Covers Mojang's modern year-based 26.x naming as well.
  return major === 1 && minor >= 20;
}

export function formatMinecraftServerTarget(address: unknown, port: unknown): string {
  const host = assertServerAddress(address);
  const safePort = assertServerPort(port);
  const displayHost = net.isIP(host) === 6 ? `[${host}]` : host;
  return `${displayHost}:${safePort}`;
}

export function buildServerLaunchArgs(minecraftVersion: string, address: unknown, port: unknown): string[] {
  const host = assertServerAddress(address);
  const safePort = assertServerPort(port);
  if (supportsQuickPlayMultiplayer(minecraftVersion)) {
    return ["--quickPlayMultiplayer", formatMinecraftServerTarget(host, safePort)];
  }
  return ["--server", host, "--port", String(safePort)];
}

export function buildConfiguredServerLaunchArgs(
  minecraftVersion: string,
  server: {
    serverAddress: unknown;
    serverPort: unknown;
    autoConnect: boolean;
    allowUserOverride: boolean;
  },
  override?: { address: unknown; port: unknown },
): { args: string[]; target: string; usedOverride: boolean } {
  if (!server.autoConnect) return { args: [], target: "", usedOverride: false };
  const usedOverride = Boolean(server.allowUserOverride && override);
  const address = usedOverride ? override!.address : server.serverAddress;
  const port = usedOverride ? override!.port : server.serverPort;
  return {
    args: buildServerLaunchArgs(minecraftVersion, address, port),
    target: formatMinecraftServerTarget(address, port),
    usedOverride,
  };
}
