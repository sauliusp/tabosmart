import { namingPlan, titleData } from "./topic-evidence.mjs";

export const DISCOVERY_BATCH = 24;
const safeText = (s, max) =>
  typeof s === "string" &&
  s.trim() &&
  s.length <= max &&
  !/[<>\n\r\u0000-\u001f\u007f]|https?:|www\./iu.test(s);
export function discoveryEligible(tab) {
  try {
    const u = new URL(tab.url);
    return (
      Number.isSafeInteger(tab.id) &&
      Number.isSafeInteger(tab.windowId) &&
      ["http:", "https:"].includes(u.protocol) &&
      !u.username &&
      !u.password &&
      !tab.incognito &&
      !tab.protected &&
      !tab.pinned &&
      !tab.audible &&
      (tab.groupId ?? -1) === -1
    );
  } catch {
    return false;
  }
}
/** Exact local cache identity. Full URLs are never included in model input. */
export function discoveryKey(snapshot) {
  return JSON.stringify([
    !!snapshot?.settings?.enabled,
    !!snapshot?.settings?.aiEnabled,
    snapshot?.settings?.groupNameLanguage || "auto",
    (snapshot?.tabs || [])
      .map((t) => [
        t.id,
        t.url,
        t.title,
        t.windowId,
        t.groupId ?? -1,
        !!t.protected,
        !!t.pinned,
        !!t.audible,
        !!t.incognito,
      ])
      .sort((a, b) => a[0] - b[0]),
  ]);
}
export function discoveryBatches(snapshot) {
  const occupied = new Set(
    (snapshot.suggestions || [])
      .filter((s) => s.type !== "inactive" && !s.aiDiscovered)
      .flatMap((s) => s.tabIds),
  );
  const windows = new Map();
  for (const tab of [...(snapshot.tabs || [])].sort(
    (a, b) =>
      Number(b.active) - Number(a.active) ||
      (b.lastUsedAt || 0) - (a.lastUsedAt || 0) ||
      a.id - b.id,
  )) {
    if (
      !discoveryEligible(tab) ||
      occupied.has(tab.id) ||
      !titleData(tab).size ||
      !namingPlan([tab], snapshot.settings.groupNameLanguage).modelEligible
    )
      continue;
    const list = windows.get(tab.windowId) || [];
    list.push(tab);
    windows.set(tab.windowId, list);
  }
  const batches = [];
  for (const tabs of windows.values()) {
    for (let i = 0; i < tabs.length; i += DISCOVERY_BATCH) {
      const batch = tabs.slice(i, i + DISCOVERY_BATCH);
      if (batch.length >= 2) batches.push(batch);
    }
  }
  return batches;
}
export function discoveryMetadata(tabs, at = Date.now()) {
  if (
    !Array.isArray(tabs) ||
    tabs.length < 2 ||
    tabs.length > DISCOVERY_BATCH ||
    tabs.some((t) => !discoveryEligible(t))
  )
    return null;
  return tabs.map((t) => ({
    id: t.id,
    title: String(t.title || "")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .slice(0, 160),
    domain: new URL(t.url).hostname.slice(0, 253),
    active: t.active === true,
    usedRecently:
      Number.isFinite(t.lastUsedAt) &&
      at - t.lastUsedAt >= 0 &&
      at - t.lastUsedAt < 86400000,
    observedUses: Math.max(0, Math.min(1000, Math.floor(t.visitCount || 0))),
  }));
}
/** Structural/evidence validation, not proof that an inferred relationship is true. */
export function validateDiscoveredGroups(value, tabs) {
  if (
    !Array.isArray(value) ||
    value.length > 6 ||
    !Array.isArray(tabs) ||
    tabs.length > DISCOVERY_BATCH
  )
    return [];
  const lookup = new Map(tabs.map((t) => [t.id, t])),
    used = new Set(),
    results = [];
  for (const group of value) {
    if (
      !group ||
      !safeText(group.name, 36) ||
      group.name.trim().split(/\s+/u).length > 4 ||
      !["task", "topic"].includes(group.relationship) ||
      !Array.isArray(group.members) ||
      group.members.length < 2 ||
      group.members.length > DISCOVERY_BATCH
    )
      continue;
    const ids = new Set(),
      members = [];
    let invalid = false;
    for (const member of group.members) {
      const tab = lookup.get(member?.id);
      // Every member needs a literal, informative title quote. Domains and
      // model world knowledge alone cannot fabricate a brand-only relationship.
      if (
        !tab ||
        !discoveryEligible(tab) ||
        ids.has(tab.id) ||
        used.has(tab.id) ||
        !safeText(member.evidence, 100) ||
        !String(tab.title || "")
          .replace(/[\u0000-\u001f\u007f]/g, " ")
          .slice(0, 160)
          .includes(member.evidence) ||
        !titleData({ ...tab, title: member.evidence }).size
      ) {
        invalid = true;
        break;
      }
      ids.add(tab.id);
      members.push({ id: tab.id, evidence: member.evidence });
    }
    if (
      invalid ||
      new Set(members.map((m) => lookup.get(m.id).windowId)).size !== 1
    )
      continue;
    members.forEach((m) => used.add(m.id));
    results.push({
      name: group.name.trim(),
      relationship: group.relationship,
      members,
    });
  }
  return results;
}

export function validateDiscoveryHints(value, tabs) {
  if (!Array.isArray(value) || value.length > DISCOVERY_BATCH) return [];
  const seen = new Set();
  return value
    .filter((hint) => {
      const tab = tabs.find((t) => t.id === hint?.id);
      if (
        !tab ||
        seen.has(tab.id) ||
        !safeText(hint.concept, 60) ||
        !safeText(hint.evidence, 100) ||
        !String(tab.title || "")
          .slice(0, 160)
          .includes(hint.evidence) ||
        !titleData({ ...tab, title: hint.evidence }).size ||
        !titleData({ title: hint.concept, url: "https://metadata.invalid" })
          .size
      )
        return false;
      seen.add(tab.id);
      return true;
    })
    .map((h) => ({ id: h.id, concept: h.concept, evidence: h.evidence }));
}

/** Inferred short concepts nominate cross-batch comparisons; only a later
 * validated model proposal can become a suggestion. Never all-pairs inference. */
export function crossDiscoveryBatches(snapshot, hints) {
  const buckets = new Map(),
    lookup = new Map(
      (snapshot.tabs || []).filter(discoveryEligible).map((t) => [t.id, t]),
    );
  for (const hint of hints) {
    const tab = lookup.get(hint.id);
    if (!tab) continue;
    for (const word of titleData({
      title: hint.concept,
      url: "https://metadata.invalid",
    }).keys()) {
      const key = `${tab.windowId}:${word}`,
        ids = buckets.get(key) || new Set();
      ids.add(tab.id);
      buckets.set(key, ids);
    }
  }
  const seen = new Set(),
    batches = [];
  for (const ids of buckets.values()) {
    if (ids.size < 2) continue;
    const members = [...ids].sort((a, b) => a - b);
    for (let i = 0; i < members.length; i += DISCOVERY_BATCH - 2) {
      // Two shared representatives connect successive chunks of a large concept.
      const batchIds = [
        ...new Set([
          ...(i ? members.slice(0, 2) : []),
          ...members.slice(i, i + DISCOVERY_BATCH - (i ? 2 : 0)),
        ]),
      ];
      if (batchIds.length < 2) continue;
      const key = batchIds.join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      batches.push(batchIds.map((id) => lookup.get(id)));
    }
  }
  return batches;
}
