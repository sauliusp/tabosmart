import test from "node:test";
import assert from "node:assert/strict";
import { createState } from "../extension/core.mjs";
import {
  serializedBytes,
  prepareStorageState,
  assertUserDataCapacity,
  STORAGE_BUDGET,
  USER_DATA_BUDGET,
} from "../extension/storage-budget.mjs";

test("serialized byte budget prunes long Unicode observations while preserving saved intent", () => {
  const state = createState(1000);
  state.saved = [
    {
      id: "keep",
      tabs: [{ url: "https://keep.test/work", title: "Keep this" }],
    },
  ];
  for (let i = 0; i < 2000; i++) {
    const url = `https://long.test/${i}?q=${"界".repeat(5000)}`;
    state.observations[i] = { url, lastSeenAt: i };
    state.urlHistory[url] = { lastSeenAt: i };
  }
  state.cached = { tabs: Object.values(state.observations), suggestions: [] };
  const saved = structuredClone(state.saved);
  const payload = prepareStorageState(state);
  assert(serializedBytes(payload) < STORAGE_BUDGET);
  assert.deepEqual(payload.saved, saved);
  assert.equal(payload.cached, null);
  assert.equal(
    state.cached.tabs.length,
    2000,
    "live display is not silently truncated",
  );
  assert(state.observations[1999], "newest measured context remains");
  assert(!state.observations[0], "oldest context is evicted first");
});

test("user-owned byte limit refuses growth without evicting saved or recovery URLs", () => {
  const previous = createState();
  const next = {
    ...previous,
    saved: [{ tabs: [{ url: "x".repeat(USER_DATA_BUDGET) }] }],
  };
  assert.throws(() => assertUserDataCapacity(next, previous), {
    code: "STORAGE_FULL",
  });
  assert.deepEqual(previous.saved, []);
  assert.doesNotThrow(
    () => assertUserDataCapacity(previous, next),
    "removal is always allowed",
  );
});
