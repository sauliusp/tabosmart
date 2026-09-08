import { discoveryEligible } from "./group-discovery.mjs";
import { categoryEvidence, resourceScope } from "./metadata-groups.mjs";
import { titleData } from "./topic-evidence.mjs";

// A review captures the entire reference identity, never a selected subset that
// could hide unrelated members. Oversized groups can continue to be managed in Chrome.
const MAX_REFERENCE_MEMBERS = 256;

function commonKeys(records, field) {
  if (!records.length) return [];
  return [...records[0][field].keys()]
    .filter((key) => records.every((record) => record[field].has(key)))
    .sort();
}

function describe(tab) {
  return {
    tab,
    scope: resourceScope(tab),
    words: titleData(tab),
    categories: new Map(
      categoryEvidence(tab).map((entry) => [entry.key, entry]),
    ),
  };
}

function referenceFor(group, records) {
  if (
    !Number.isSafeInteger(group?.id) ||
    group.id < 0 ||
    !Number.isSafeInteger(group.windowId) ||
    typeof group.title !== "string" ||
    !group.title.trim()
  )
    return null;
  const members = records.filter(
    ({ tab }) => tab.groupId === group.id && tab.windowId === group.windowId,
  );
  if (
    !members.length ||
    members.length > MAX_REFERENCE_MEMBERS ||
    members.some(({ tab }) => !discoveryEligible({ ...tab, groupId: -1 }))
  )
    return null;
  const scope =
    members[0].scope &&
    members.every((member) => member.scope?.key === members[0].scope.key)
      ? members[0].scope
      : null;
  return {
    group,
    members,
    scope,
    anchors: members.length >= 2 ? commonKeys(members, "words") : [],
    categories: members.length >= 2 ? commonKeys(members, "categories") : [],
  };
}

function relationship(record, reference) {
  if (record.tab.windowId !== reference.group.windowId) return null;
  if (reference.scope && record.scope?.key === reference.scope.key)
    return {
      key: `scope:${reference.scope.key}`,
      description: `the specific ${reference.scope.kind || "resource"} “${reference.scope.label}” in their URLs`,
    };

  // Generic title similarities must not overrule an explicit different project
  // or document identity when the existing group has one coherent resource.
  if (reference.scope && record.scope) return null;
  const anchors = reference.anchors.filter((key) => record.words.has(key));
  if (anchors.length >= 2) {
    const selected = anchors.slice(0, 2);
    const words = selected.map((key) => reference.members[0].words.get(key));
    return {
      key: `title:${selected.join("|")}`,
      description: `the title words ${words.map((word) => `“${word}”`).join(" and ")}`,
    };
  }
  const categoryKey = reference.categories.find((key) =>
    record.categories.has(key),
  );
  if (categoryKey) {
    const evidence = record.categories.get(categoryKey);
    return {
      key: `category:${categoryKey}`,
      description: `the “${evidence.label}” category indicated by title or URL metadata`,
    };
  }
  return null;
}

/**
 * Suggest additions using every current group member as reference evidence.
 * Group titles supply the destination name only; they never prove membership.
 * Returned tabs contain only proposed additions. No existing tab is moved here.
 */
export function discoverExistingGroupMatches(
  tabs,
  nativeGroups,
  preference = "auto",
  excludedAdditions = new Set(),
) {
  // A chosen naming language must not rename an existing Chrome group.
  void preference;
  if (!Array.isArray(tabs) || !Array.isArray(nativeGroups)) return [];
  const records = tabs
    .filter((tab) => tab && Number.isSafeInteger(tab.id))
    .map(describe)
    .sort((a, b) => a.tab.windowId - b.tab.windowId || a.tab.id - b.tab.id);
  const references = nativeGroups
    .map((group) => referenceFor(group, records))
    .filter(Boolean)
    .sort(
      (a, b) => a.group.windowId - b.group.windowId || a.group.id - b.group.id,
    );
  const assignments = new Map();
  for (const record of records) {
    if (!discoveryEligible(record.tab) || excludedAdditions.has(record.tab.id))
      continue;
    const matches = references
      .map((reference) => ({
        reference,
        evidence: relationship(record, reference),
      }))
      .filter((match) => match.evidence);
    // The user must choose between plausible destinations. Do not quietly use
    // iteration order or the group's name to resolve an ambiguous membership.
    if (matches.length !== 1) continue;
    const { reference, evidence } = matches[0];
    const entries = assignments.get(reference) || [];
    entries.push({ tab: record.tab, evidence });
    assignments.set(reference, entries);
  }
  return [...assignments].map(([reference, entries]) => {
    const members = entries.map((entry) => entry.tab);
    const evidenceGroups = new Map();
    for (const { evidence } of entries) {
      const prior = evidenceGroups.get(evidence.key);
      evidenceGroups.set(evidence.key, {
        ...evidence,
        count: (prior?.count || 0) + 1,
      });
    }
    const name = reference.group.title;
    const reason = [...evidenceGroups.values()]
      .map(
        ({ count, description }) =>
          `${count === 1 ? "1 tab shares" : `${count} tabs share`} ${description} with every current member of “${name}”.`,
      )
      .join(" ");
    return {
      tabs: members,
      proposedName: name,
      title: `Add ${members.length} ${members.length === 1 ? "tab" : "tabs"} to “${name}”`,
      reason,
      signal: "existing-group",
      priority: 100,
      nameLocked: true,
      targetGroup: {
        id: reference.group.id,
        windowId: reference.group.windowId,
        title: name,
        members: reference.members.map(({ tab }) => ({
          id: tab.id,
          url: tab.url,
        })),
      },
    };
  });
}
