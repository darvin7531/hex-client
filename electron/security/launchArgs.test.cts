import test from "node:test";
import assert from "node:assert/strict";
import { buildConfiguredServerLaunchArgs, buildServerLaunchArgs, formatMinecraftServerTarget, supportsQuickPlayMultiplayer } from "./launchArgs.cjs";

test("modern Minecraft uses Quick Play multiplayer argument", () => {
  for (const version of ["1.20", "1.20.1", "1.21.8", "26.1", "26.2"]) {
    assert.equal(supportsQuickPlayMultiplayer(version), true, version);
    assert.deepEqual(buildServerLaunchArgs(version, "play.example.org", 25565), [
      "--quickPlayMultiplayer",
      "play.example.org:25565",
    ]);
  }
});

test("pre-1.20 Minecraft keeps legacy server arguments", () => {
  assert.equal(supportsQuickPlayMultiplayer("1.19.4"), false);
  assert.deepEqual(buildServerLaunchArgs("1.19.4", "play.example.org", 25566), [
    "--server",
    "play.example.org",
    "--port",
    "25566",
  ]);
});

test("Quick Play formats IPv6 server targets safely", () => {
  assert.equal(formatMinecraftServerTarget("2001:db8::1", 25565), "[2001:db8::1]:25565");
});

test("server bootstrap disables auto-connect completely", () => {
  const result = buildConfiguredServerLaunchArgs("1.21.8", {
    serverAddress: "play.example.test",
    serverPort: 25565,
    autoConnect: false,
    allowUserOverride: true,
  }, { address: "override.example.test", port: 25570 });
  assert.deepEqual(result, { args: [], target: "", usedOverride: false });
});

test("server override is ignored unless backend explicitly allows it", () => {
  const result = buildConfiguredServerLaunchArgs("1.21.8", {
    serverAddress: "play.example.test",
    serverPort: 25565,
    autoConnect: true,
    allowUserOverride: false,
  }, { address: "override.example.test", port: 25570 });
  assert.deepEqual(result.args, ["--quickPlayMultiplayer", "play.example.test:25565"]);
  assert.equal(result.target, "play.example.test:25565");
  assert.equal(result.usedOverride, false);
});

test("server override is used when backend allows it", () => {
  const result = buildConfiguredServerLaunchArgs("1.21.8", {
    serverAddress: "play.example.test",
    serverPort: 25565,
    autoConnect: true,
    allowUserOverride: true,
  }, { address: "override.example.test", port: 25570 });
  assert.deepEqual(result.args, ["--quickPlayMultiplayer", "override.example.test:25570"]);
  assert.equal(result.target, "override.example.test:25570");
  assert.equal(result.usedOverride, true);
});
