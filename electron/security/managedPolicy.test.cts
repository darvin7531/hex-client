import test from "node:test";
import assert from "node:assert/strict";
import { shouldPreserveExistingManagedFile, shouldPreserveObsoleteManagedFile, shouldVerifyManagedHash } from "./managedPolicy.cjs";

test("required_keep_if_same preserves user-modified files but upgrades untouched defaults", () => {
  assert.equal(shouldPreserveExistingManagedFile({ updatePolicy: "required_keep_if_same", preserveUserChanges: false, currentHash: "user", previousHash: "old", expectedHash: "new" }), true);
  assert.equal(shouldPreserveExistingManagedFile({ updatePolicy: "required_keep_if_same", preserveUserChanges: false, currentHash: "old", previousHash: "old", expectedHash: "new" }), false);
  assert.equal(shouldPreserveExistingManagedFile({ updatePolicy: "required_keep_if_same", preserveUserChanges: false, currentHash: "new", previousHash: "old", expectedHash: "new" }), false);
});

test("strict verification and obsolete cleanup honor preservation policies", () => {
  assert.equal(shouldVerifyManagedHash("required_replace", false), true);
  assert.equal(shouldVerifyManagedHash("required_keep_if_same", false), false);
  assert.equal(shouldVerifyManagedHash("required_replace", true), false);
  assert.equal(shouldPreserveObsoleteManagedFile("required_keep_if_same", false), true);
  assert.equal(shouldPreserveObsoleteManagedFile("required_replace", false), false);
});
