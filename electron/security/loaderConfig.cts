import { assertPackVersion } from "./validation.cjs";

export function forgeCoordinateVersion(minecraftVersion: unknown, loaderVersion: unknown): string {
  const mc = assertPackVersion(minecraftVersion)!;
  const loader = assertPackVersion(loaderVersion)!;
  return loader.startsWith(`${mc}-`) ? loader : `${mc}-${loader}`;
}

export function forgeLoaderOnlyVersion(minecraftVersion: unknown, loaderVersion: unknown): string {
  const mc = assertPackVersion(minecraftVersion)!;
  const coordinate = forgeCoordinateVersion(mc, loaderVersion);
  const prefix = `${mc}-`;
  return coordinate.startsWith(prefix) ? coordinate.slice(prefix.length) : coordinate;
}

export function forgeInstallerUrl(minecraftVersion: unknown, loaderVersion: unknown): string {
  const coordinate = forgeCoordinateVersion(minecraftVersion, loaderVersion);
  return `https://maven.minecraftforge.net/net/minecraftforge/forge/${coordinate}/forge-${coordinate}-installer.jar`;
}

export function neoForgeInstallerUrl(loaderVersion: unknown): string {
  const loader = assertPackVersion(loaderVersion)!;
  return `https://maven.neoforged.net/releases/net/neoforged/neoforge/${loader}/neoforge-${loader}-installer.jar`;
}
