import assert from "node:assert/strict";
import test from "node:test";
import { createBoundedGameEventStore } from "./gameEvents.cjs";

test("game log store keeps only the newest bounded entries", () => {
  const store = createBoundedGameEventStore(2, () => "2026-01-01T00:00:00.000Z");
  store.pushLog("stdout", "one");
  store.pushLog("stderr", "two");
  store.pushLog("stdout", "three");
  assert.deepEqual(store.getLogs().map((entry) => [entry.stream, entry.message]), [["stderr", "two"], ["stdout", "three"]]);
});

test("game log store splits chunks into complete lines and flushes trailing text", () => {
  const store = createBoundedGameEventStore(10);
  store.acceptChunk("stdout", "hello\npartial");
  store.acceptChunk("stdout", " line\r\nnext");
  assert.deepEqual(store.getLogs().map((entry) => entry.message), ["hello", "partial line"]);
  store.flush();
  assert.deepEqual(store.getLogs().map((entry) => entry.message), ["hello", "partial line", "next"]);
});

test("game state events are snapshots and carry validated lifecycle data", () => {
  const store = createBoundedGameEventStore(10);
  store.setState({ status: "running", packId: "vanilla", pid: 42 });
  const snapshot = store.getState();
  assert.deepEqual(snapshot, { status: "running", packId: "vanilla", pid: 42 });
  store.setState({ status: "exited", packId: "vanilla", exitCode: 0 });
  assert.deepEqual(snapshot, { status: "running", packId: "vanilla", pid: 42 });
});
