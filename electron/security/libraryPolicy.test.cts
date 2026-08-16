import test from "node:test";
import assert from "node:assert/strict";
import { decideLibraryResolution } from "./libraryPolicy.cjs";

test("existing valid installer library is used without network", () => {
  assert.equal(decideLibraryResolution({
    localExists: true,
    declaredHashMatches: true,
    declaredSizeMatches: true,
    hasExplicitDownloadUrl: false,
  }), "use-local");
});

test("ordinary missing library with explicit URL is downloaded", () => {
  assert.equal(decideLibraryResolution({
    localExists: false,
    declaredHashMatches: true,
    declaredSizeMatches: true,
    hasExplicitDownloadUrl: true,
  }), "download");
});

test("missing loader-generated library requests installer rerun instead of guessed download", () => {
  assert.equal(decideLibraryResolution({
    localExists: false,
    declaredHashMatches: true,
    declaredSizeMatches: true,
    hasExplicitDownloadUrl: false,
  }), "reinstall-loader");
});

test("corrupt loader-generated library requests installer rerun", () => {
  assert.equal(decideLibraryResolution({
    localExists: true,
    declaredHashMatches: false,
    declaredSizeMatches: true,
    hasExplicitDownloadUrl: false,
  }), "reinstall-loader");
});
