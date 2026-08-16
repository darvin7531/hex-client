import test from "node:test";
import assert from "node:assert/strict";
import { forgeCoordinateVersion, forgeInstallerUrl, forgeLoaderOnlyVersion, neoForgeInstallerUrl } from "./loaderConfig.cjs";

test("Forge coordinates accept both loader-only and fully-qualified versions", () => {
  assert.equal(forgeCoordinateVersion("1.21.1", "52.0.10"), "1.21.1-52.0.10");
  assert.equal(forgeCoordinateVersion("1.21.1", "1.21.1-52.0.10"), "1.21.1-52.0.10");
  assert.equal(forgeLoaderOnlyVersion("1.21.1", "1.21.1-52.0.10"), "52.0.10");
});

test("Forge installer uses the official MinecraftForge Maven coordinate", () => {
  assert.equal(
    forgeInstallerUrl("1.21.1", "52.0.10"),
    "https://maven.minecraftforge.net/net/minecraftforge/forge/1.21.1-52.0.10/forge-1.21.1-52.0.10-installer.jar",
  );
});

test("NeoForge installer uses the official NeoForged Maven coordinate", () => {
  assert.equal(
    neoForgeInstallerUrl("21.1.200"),
    "https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.200/neoforge-21.1.200-installer.jar",
  );
});
