import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  assertSameOriginHttpUrl,
  assertSilentArgs,
  normalizeApiBase,
  normalizeManagedRelativePath,
  offlineUuidFromNickname,
  safeJoinManaged,
} from "./validation.cjs";

test("backend URL requires HTTPS outside loopback", () => {
  assert.equal(normalizeApiBase("http://127.0.0.1:4000/api"), "http://127.0.0.1:4000/api");
  assert.equal(normalizeApiBase("https://launcher.example.com/api/"), "https://launcher.example.com/api");
  assert.throws(() => normalizeApiBase("http://launcher.example.com/api"));
  assert.throws(() => normalizeApiBase("https://user:pass@launcher.example.com/api"));
  assert.throws(() => normalizeApiBase("https://launcher.example.com/not-api"));
});

test("managed paths reject traversal and Windows collisions", () => {
  assert.equal(normalizeManagedRelativePath("mods/example.jar"), "mods/example.jar");
  for (const invalid of [
    "../evil.jar",
    "mods/../evil.jar",
    "mods\\evil.jar",
    "/absolute.jar",
    "C:/evil.jar",
    "mods/CON.jar",
    "mods/foo. ",
    "mods/foo ",
    "mods/a:b.jar",
  ]) {
    assert.throws(() => normalizeManagedRelativePath(invalid), invalid);
  }
});

test("safeJoinManaged never escapes its root", () => {
  const root = path.resolve("C:/HexLoader/instances/test");
  const joined = safeJoinManaged(root, "mods/example.jar");
  assert.ok(joined.startsWith(root + path.sep));
  assert.throws(() => safeJoinManaged(root, "../../outside"));
});

test("pack downloads must stay on backend origin", () => {
  const api = "https://launcher.example.com/api";
  assert.equal(
    assertSameOriginHttpUrl("https://launcher.example.com/storage/packs/a.jar", api),
    "https://launcher.example.com/storage/packs/a.jar",
  );
  assert.throws(() => assertSameOriginHttpUrl("https://evil.example/storage/a.jar", api));
  assert.throws(() => assertSameOriginHttpUrl("http://launcher.example.com/storage/a.jar", api));
});


test("offline UUID matches java.util.UUID.nameUUIDFromBytes semantics", () => {
  assert.equal(offlineUuidFromNickname("Notch"), "b50ad385829d3141a2167e7d7539ba7f");
});


test("installer arguments are restricted to known silent flags", () => {
  assert.deepEqual(assertSilentArgs(["/S", "/norestart"], "HexLoader.exe"), ["/S", "/norestart"]);
  assert.throws(() => assertSilentArgs(["TRANSFORMS=\\server\\evil.mst"]));
  assert.throws(() => assertSilentArgs(["--config=C:/tmp/evil.ini"], "HexLoader.exe"));
});


test("MSI installer arguments are validated separately from EXE arguments", () => {
  assert.deepEqual(assertSilentArgs(["/passive", "/norestart"], "HexLoader.msi"), ["/passive", "/norestart"]);
  assert.throws(() => assertSilentArgs(["/S"], "HexLoader.msi"));
  assert.throws(() => assertSilentArgs(["/qn"], "HexLoader.exe"));
});
