// Chrome's local quota includes serialized values. Keep headroom for metadata
// and refuse growth of user-owned records rather than silently discarding them.
export const STORAGE_BUDGET = 8 * 1024 * 1024;
export const USER_DATA_BUDGET = 4 * 1024 * 1024;
const encoder = new TextEncoder();
export const serializedBytes = (value) =>
  encoder.encode(JSON.stringify(value)).byteLength;
function userData(state) {
  return {
    saved: state.saved,
    recovery: state.recovery,
    protectedUrls: state.protectedUrls,
  };
}
export function assertUserDataCapacity(next, previous) {
  const bytes = serializedBytes(userData(next));
  // Existing oversized records may be removed, but cannot grow further.
  if (bytes > USER_DATA_BUDGET && bytes > serializedBytes(userData(previous))) {
    throw Object.assign(
      new Error(
        "Saved links, Recovery and protected URLs have reached their storage limit. Remove a saved list or protection before adding more.",
      ),
      { code: "STORAGE_FULL" },
    );
  }
}
function trimByBytes(records, limit) {
  const recent = Object.entries(records || {}).sort((a, b) => {
    const stamp = (value) =>
      typeof value === "number"
        ? value
        : value?.lastSeenAt || value?.closedAt || value?.at || 0;
    return stamp(b[1]) - stamp(a[1]);
  });
  let used = 2;
  const kept = [];
  for (const entry of recent) {
    const bytes = serializedBytes({ [entry[0]]: entry[1] });
    if (used + bytes <= limit) {
      kept.push(entry);
      used += bytes;
    }
  }
  return Object.fromEntries(kept);
}
export function prepareStorageState(state) {
  // These are disposable observations, never saved/recovery URLs or protections.
  for (const key of [
    "observations",
    "urlHistory",
    "startupCandidates",
    "windowClosures",
    "pairs",
    "lastActivation",
    "dismissed",
  ]) {
    if (serializedBytes(state[key] || {}) > 512 * 1024)
      state[key] = trimByBytes(state[key], 512 * 1024);
  }
  const stored = { ...state };
  // Keep the complete current display in memory even when it is too large to cache.
  if (serializedBytes(stored.cached) > 1024 * 1024) stored.cached = null;
  if (serializedBytes(stored) > STORAGE_BUDGET) stored.cached = null;
  if (serializedBytes(stored) > STORAGE_BUDGET) {
    for (const key of [
      "observations",
      "urlHistory",
      "startupCandidates",
      "windowClosures",
      "pairs",
      "lastActivation",
      "dismissed",
    ]) {
      state[key] = stored[key] = {};
    }
  }
  if (serializedBytes(stored) > STORAGE_BUDGET) {
    throw Object.assign(
      new Error(
        "Existing saved data exceeds the local storage budget. Remove a saved list or erase local data to free space.",
      ),
      { code: "STORAGE_FULL" },
    );
  }
  return stored;
}
