import test from "node:test";
import assert from "node:assert/strict";
import { mavenIdentity, mavenPathFromCoordinate, parseMavenCoordinate } from "./mavenCoordinate.cjs";

test("Maven coordinate parser supports classifier and extension", () => {
  assert.deepEqual(parseMavenCoordinate("org.lwjgl:lwjgl:3.3.3:natives-windows@jar"), {
    group: "org.lwjgl", artifact: "lwjgl", version: "3.3.3", classifier: "natives-windows", extension: "jar",
  });
  assert.equal(
    mavenPathFromCoordinate("org.lwjgl:lwjgl:3.3.3:natives-windows@jar"),
    "org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar",
  );
});

test("Maven identity ignores version so child loader metadata can override parent library", () => {
  assert.equal(mavenIdentity("com.example:lib:1.0.0"), mavenIdentity("com.example:lib:2.0.0"));
  assert.notEqual(mavenIdentity("com.example:lib:2.0.0:client"), mavenIdentity("com.example:lib:2.0.0"));
});

test("Maven coordinate parser rejects path/control syntax", () => {
  assert.throws(() => parseMavenCoordinate("com.example:../evil:1.0"), /Invalid Maven artifact/);
  assert.throws(() => parseMavenCoordinate("too:few"), /Unsupported Maven coordinate/);
});
