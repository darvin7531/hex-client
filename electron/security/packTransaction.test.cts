import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { commitPackTransaction } from "./packTransaction.cjs";

const noSymlinkCheck = async () => {};

async function tempFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hexloader-txn-test-"));
  const instance = path.join(root, "instance");
  const txn = path.join(instance, ".hexloader-txn-test");
  await fs.mkdir(path.join(instance, "mods"), { recursive: true });
  await fs.mkdir(path.join(txn, "new", "mods"), { recursive: true });
  return { root, instance, txn };
}

test("pack transaction commits replacements and stale-file removal", async (t) => {
  const { root, instance, txn } = await tempFixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await fs.writeFile(path.join(instance, "mods", "a.jar"), "OLD-A");
  await fs.writeFile(path.join(instance, "mods", "stale.jar"), "STALE");
  await fs.writeFile(path.join(txn, "new", "mods", "a.jar"), "NEW-A");

  const result = await commitPackTransaction(
    instance,
    txn,
    ["mods/a.jar"],
    ["mods/stale.jar"],
    noSymlinkCheck,
  );

  assert.equal(await fs.readFile(path.join(instance, "mods", "a.jar"), "utf8"), "NEW-A");
  await assert.rejects(fs.access(path.join(instance, "mods", "stale.jar")));
  assert.deepEqual(result.removedPaths, ["mods/stale.jar"]);
});

test("pack transaction rolls back earlier replacements if a later commit fails", async (t) => {
  const { root, instance, txn } = await tempFixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await fs.writeFile(path.join(instance, "mods", "a.jar"), "OLD-A");
  await fs.writeFile(path.join(instance, "mods", "b.jar"), "OLD-B");
  await fs.writeFile(path.join(txn, "new", "mods", "a.jar"), "NEW-A");
  // mods/b.jar is intentionally absent from staging so the second rename fails.

  await assert.rejects(() => commitPackTransaction(
    instance,
    txn,
    ["mods/a.jar", "mods/b.jar"],
    [],
    noSymlinkCheck,
  ));

  assert.equal(await fs.readFile(path.join(instance, "mods", "a.jar"), "utf8"), "OLD-A");
  assert.equal(await fs.readFile(path.join(instance, "mods", "b.jar"), "utf8"), "OLD-B");
});
