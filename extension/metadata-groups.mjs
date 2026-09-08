import { discoveryEligible } from "./group-discovery.mjs";
import {
  discoverMetadataGroups,
  namingPlan,
  normalizeText,
  textWords,
  titleData,
} from "./topic-evidence.mjs";

// URL schemas describe resources, never a catalogue of publisher identities.
const SCOPE_MARKERS = new Map([
  ["projects", "project"],
  ["project", "project"],
  ["workspaces", "workspace"],
  ["workspace", "workspace"],
  ["repositories", "repository"],
  ["repos", "repository"],
  ["products", "product"],
  ["product", "product"],
]);
const GENERIC_RESOURCE = new Set(
  "new create all list index home search settings account dashboard edit view current default undefined null".split(
    " ",
  ),
);
const REPO_ROUTES = new Set(
  "issues issue pull pulls tree blob actions discussions projects wiki releases compare settings commits commit branches tags src downloads pipelines".split(
    " ",
  ),
);
const HOST_ROUTES = new Set(
  "search settings notifications marketplace orgs users login signup explore topics trending sponsors features enterprise pricing copilot dashboard groups help projects snippets".split(
    " ",
  ),
);
function webURL(tab) {
  try {
    const url = new URL(tab?.url);
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url
      : null;
  } catch {
    return null;
  }
}
function segments(url) {
  try {
    return url.pathname
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part).normalize("NFC"));
  } catch {
    return [];
  }
}
function usableSlug(value, opaque = false) {
  return (
    typeof value === "string" &&
    value.length >= 2 &&
    value.length <= 100 &&
    !/[\s/\\<>\u0000-\u001f\u007f]/u.test(value) &&
    !GENERIC_RESOURCE.has(normalizeText(value)) &&
    (opaque ||
      (/\p{L}/u.test(value) &&
        !/^[a-f0-9]{16,}$/i.test(value) &&
        !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value)))
  );
}
function scope(url, parts, depth, label, kind) {
  return {
    key: JSON.stringify([
      url.host.toLowerCase().replace(/^www\./, ""),
      parts.slice(0, depth),
    ]),
    label: label.replace(/[_-]+/g, " ").slice(0, 60),
    kind,
  };
}
/** A specific resource in the URL; null for generic pages, homepages and searches.
 * URL queries, tracking parameters, positions and publisher identity are not scope.
 * Known document schemas may use opaque IDs; arbitrary numeric paths never do.
 */
export function resourceScope(tab) {
  const url = webURL(tab);
  if (!url) return null;
  const parts = segments(url),
    host = url.hostname.replace(/^www\./, "");
  if (["github.com", "gitlab.com", "bitbucket.org"].includes(host)) {
    if (
      parts.length >= 2 &&
      !HOST_ROUTES.has(parts[0]) &&
      usableSlug(parts[0]) &&
      usableSlug(parts[1]) &&
      (parts.length === 2 || REPO_ROUTES.has(parts[2]) || parts[2] === "-")
    )
      return scope(url, parts, 2, `${parts[0]}/${parts[1]}`, "repository");
    return null;
  }
  if (host === "docs.google.com") {
    const identityIndex = parts[2] === "e" ? 3 : 2;
    if (
      ["document", "spreadsheets", "presentation", "forms"].includes(
        parts[0],
      ) &&
      parts[1] === "d" &&
      usableSlug(parts[identityIndex], true)
    )
      return scope(
        url,
        parts,
        identityIndex + 1,
        "Shared document",
        "document",
      );
    return null;
  }
  if (host === "drive.google.com") {
    const index = parts.indexOf("folders");
    if (parts[0] === "drive" && index > 0 && usableSlug(parts[index + 1], true))
      return scope(url, parts, index + 2, "Drive folder", "folder");
    return null;
  }
  // An explicit marker is needed. /article/123 and /london/hotels alone cannot
  // establish a workspace; /teams/acme/projects/client-portal can.
  for (let i = 0; i < Math.min(parts.length - 1, 6); i++) {
    const kind = SCOPE_MARKERS.get(parts[i].toLowerCase());
    if (kind && usableSlug(parts[i + 1]))
      return scope(url, parts, i + 2, parts[i + 1], kind);
  }
  return null;
}

/** A shared host is too broad for services with unrelated user workspaces. */
export function canGroupWholeSite(tabs) {
  return (
    Array.isArray(tabs) &&
    tabs.length > 0 &&
    tabs.every((tab) => {
      const url = webURL(tab);
      if (!url) return false;
      const host = url.hostname.replace(/^www\./, "");
      if (
        [
          "github.com",
          "gitlab.com",
          "bitbucket.org",
          "docs.google.com",
          "drive.google.com",
          "mail.google.com",
          "notion.so",
          "notion.site",
          "figma.com",
          "trello.com",
          "app.asana.com",
        ].includes(host) ||
        host.endsWith(".atlassian.net")
      )
        return false;
      return !segments(url).some((part) =>
        SCOPE_MARKERS.has(part.toLowerCase()),
      );
    })
  );
}

/** Shared service owners and URL routes are not a topic across distinct resources.
 * Keep literal topic evidence, including genuine work spanning repositories or
 * documents. Ordinary cross-site title matches retain their existing evidence.
 */
export function scopeAwareTitleGroups(tabs, preference = "auto") {
  const eligibleTabs = (Array.isArray(tabs) ? tabs : []).filter(
    discoveryEligible,
  );
  const context = new Map();
  for (const tab of eligibleTabs) {
    const url = webURL(tab);
    context.set(tab.id, {
      host: url.hostname.replace(/^www\./, ""),
      resource: resourceScope(tab),
      pathWords: segments(url).flatMap((part) =>
        textWords(part.replace(/[_-]+/g, " ")).map(normalizeText),
      ),
    });
  }
  const results = [];
  const seen = new Set();
  for (const proposal of discoverMetadataGroups(eligibleTabs, preference)) {
    const hosts = new Map();
    for (const tab of proposal.tabs) {
      const row = context.get(tab.id);
      if (!row.resource) continue;
      const records = hosts.get(row.host) || [];
      records.push(row);
      hosts.set(row.host, records);
    }
    const contextualWords = new Set();
    let conflictingResources = false;
    for (const records of hosts.values()) {
      if (new Set(records.map((row) => row.resource.key)).size < 2) continue;
      conflictingResources = true;
      for (const row of records) {
        row.pathWords.forEach((word) => contextualWords.add(word));
        if (row.resource.kind === "repository")
          REPO_ROUTES.forEach((word) => contextualWords.add(word));
      }
    }
    if (!conflictingResources) {
      results.push(proposal);
      continue;
    }
    const anchors = proposal.anchors.filter(
      (word) => !contextualWords.has(word),
    );
    if (anchors.length < 2) continue;
    const words = titleData(proposal.tabs[0]);
    const display = [...words.keys()]
      .filter((word) => anchors.includes(word))
      .slice(0, 3);
    const name = display
      .map((word) => words.get(word))
      .join(" ")
      .slice(0, 60);
    const key = JSON.stringify([proposal.tabs.map((tab) => tab.id), anchors]);
    if (seen.has(key)) continue;
    seen.add(key);
    const sites = new Set(proposal.tabs.map((tab) => context.get(tab.id).host))
      .size;
    results.push({
      ...proposal,
      anchors,
      proposedName: name.charAt(0).toUpperCase() + name.slice(1),
      title: `Bring ${name} together`,
      reason: `${proposal.tabs.length} ungrouped tabs from ${sites} ${sites === 1 ? "site" : "sites"} share the title words “${display
        .slice(0, 2)
        .map((word) => words.get(word))
        .join("” and “")}”. They are in the same window.`,
    });
  }
  return results.sort(
    (a, b) =>
      b.tabs.length - a.tabs.length ||
      b.anchors.length - a.anchors.length ||
      a.tabs[0].windowId - b.tabs[0].windowId ||
      a.tabs[0].id - b.tabs[0].id ||
      a.anchors.join().localeCompare(b.anchors.join()),
  );
}

// Small, explicit multilingual vocabularies support cold starts. These are
// category cues, not universal language understanding or domain classification.
const CATEGORIES = [
  {
    id: "news",
    words:
      "news naujienos naujienu zinios ziniu nachrichten actualites noticias wiadomosci aktualnosci notizie noticias nieuwsoverzicht nieuws новини новости ニュース 新闻 新聞 أخبار اخبار",
    names: {
      en: "News",
      lt: "Naujienos",
      de: "Nachrichten",
      fr: "Actualités",
      es: "Noticias",
      pl: "Wiadomości",
      ja: "ニュース",
    },
  },
  {
    id: "recipes",
    words:
      "recipes recipe receptai receptas rezept rezepte recette recettes recetas receta przepisy przepis ricette receita receitas recepten рецепт рецепты рецепти レシピ 食谱 食譜 وصفات",
    names: {
      en: "Recipes",
      lt: "Receptai",
      de: "Rezepte",
      fr: "Recettes",
      es: "Recetas",
      pl: "Przepisy",
      ja: "レシピ",
    },
  },
  {
    id: "accommodation",
    words:
      "hotels hotel accommodation lodging viesbuciai viesbutis nakvyne unterkunft unterkunfte hebergement hoteles alojamiento noclegi hotele alloggi alberghi hospedagem alojamento overnachtingen отели готелі проживання ホテル 宿泊 酒店 住宿 فنادق",
    names: {
      en: "Accommodation",
      lt: "Nakvynė",
      de: "Unterkünfte",
      fr: "Hébergement",
      es: "Alojamiento",
      pl: "Noclegi",
      ja: "宿泊",
    },
  },
  {
    id: "documentation",
    words:
      "documentation dokumentacija dokumentation documentacion dokumentacja documentazione documentacao documentatie документация документація ドキュメント 文档 文件說明",
    names: {
      en: "Documentation",
      lt: "Dokumentacija",
      de: "Dokumentation",
      fr: "Documentation",
      es: "Documentación",
      pl: "Dokumentacja",
      ja: "ドキュメント",
    },
  },
];
const LOOKUP = new Map();
for (const category of CATEGORIES) {
  category.tokens = new Set(textWords(category.words).map(normalizeText));
  for (const token of category.tokens) {
    const rows = LOOKUP.get(token) || [];
    rows.push(category);
    LOOKUP.set(token, rows);
  }
}
const LANGUAGE_PATH = /^[a-z]{2}(?:-[a-z]{2})?$/i;
const REFERENCE_PATHS = new Set([
  "wiki",
  "w",
  "search",
  "help",
  "tutorial",
  "tutorials",
  "guide",
  "guides",
]);
const DISCUSSION_TITLE =
  /\b(?:how to|what is|what are|history of|guide to|tutorial|wikipedia|encyclopedia|kaip|kas yra|wie man|was ist|comment|como|jak)\b/u;
const TITLE_SECTION_FILLER = new Set(
  "latest breaking live world local today daily top the and online portal homepage home official naujausios naujausi pagrindinis portalas ziniu siandien tiesiogiai aktualne glowna strona aktuell aktuelle heute neueste accueil dernier dernieres nouvelles ultima ultimas últimas actualidad"
    .split(" ")
    .map(normalizeText),
);
export function categoryEvidence(tab) {
  const url = webURL(tab);
  if (!url || resourceScope(tab)) return [];
  const title = String(tab.title || "").slice(0, 300);
  const titleNormalized = normalizeText(title);
  const parts = segments(url).map(normalizeText);
  const contentParts = LANGUAGE_PATH.test(parts[0] || "")
    ? parts.slice(1)
    : parts;
  // An article explaining a category is not evidence that its site is in it.
  if (
    REFERENCE_PATHS.has(contentParts[0]) ||
    DISCUSSION_TITLE.test(titleNormalized)
  )
    return [];
  const evidence = new Map();
  for (const section of contentParts.slice(0, 2))
    for (const category of LOOKUP.get(section) || [])
      evidence.set(category.id, {
        category,
        source: "URL section",
        cue: section,
      });
  const homepage =
    !contentParts.length ||
    /^(?:index\.(?:html?|php)|home|international)$/.test(
      contentParts.join("/"),
    );
  const titleSections = title.split(/\s+[|·:–-]\s+|\s*\|\s*/u);
  const sections = homepage
    ? [title]
    : titleSections.filter((section) => {
        const words = textWords(section).map(normalizeText);
        return (
          words.length > 0 &&
          words.length <= 8 &&
          words.every(
            (word) => LOOKUP.has(word) || TITLE_SECTION_FILLER.has(word),
          )
        );
      });
  for (const section of sections)
    for (const word of textWords(section))
      for (const category of LOOKUP.get(normalizeText(word)) || [])
        evidence.set(category.id, {
          category,
          source: "title",
          cue: normalizeText(word),
          displayCue: word,
        });
  // A mixed directory homepage is ambiguous; don't place it in several groups.
  return evidence.size === 1
    ? [...evidence.values()].map((row) => ({
        ...row,
        key: row.category.id,
        label: row.category.names.en,
      }))
    : [];
}

/** Indexed URL and category proposals. No all-pairs matching or browsing wait.
 * Every member has direct evidence; stronger URL workspaces precede categories.
 */
export function discoverStructuredGroups(tabs, preference = "auto") {
  const workspaces = new Map(),
    categories = new Map(),
    ids = new Set();
  const ordered = (Array.isArray(tabs) ? tabs : [])
    .filter(discoveryEligible)
    .sort((a, b) => a.windowId - b.windowId || a.id - b.id);
  for (const tab of ordered) {
    if (ids.has(tab.id)) continue;
    ids.add(tab.id);
    const resource = resourceScope(tab);
    if (resource) {
      const key = JSON.stringify([tab.windowId, resource.key]);
      const row = workspaces.get(key) || { resource, tabs: [] };
      row.tabs.push(tab);
      workspaces.set(key, row);
      continue;
    }
    for (const evidence of categoryEvidence(tab)) {
      const key = JSON.stringify([tab.windowId, evidence.category.id]);
      const row = categories.get(key) || {
        category: evidence.category,
        tabs: [],
        sources: new Set(),
        cues: new Map(),
      };
      row.tabs.push(tab);
      row.sources.add(evidence.source);
      row.cues.set(evidence.cue, evidence.displayCue || evidence.cue);
      categories.set(key, row);
    }
  }
  const proposals = [];
  for (const { resource, tabs: members } of workspaces.values()) {
    if (members.length < 2) continue;
    const proposedName =
      resource.label.charAt(0).toUpperCase() + resource.label.slice(1);
    proposals.push({
      tabs: members,
      proposedName,
      title: `Bring ${proposedName} together`,
      reason: `${members.length} ungrouped tabs identify the same ${resource.kind} in their URL paths. They are in the same window.`,
      signal: "workspace",
      priority: 90,
      resourceKey: resource.key,
    });
  }
  for (const {
    category,
    tabs: members,
    sources,
    cues,
  } of categories.values()) {
    if (members.length < 2) continue;
    const language = namingPlan(members, preference).language;
    const proposedName = category.names[language] || category.names.en;
    const source =
      sources.size > 1
        ? "titles or URL sections"
        : sources.has("title")
          ? "titles"
          : "URL sections";
    proposals.push({
      tabs: members,
      proposedName,
      title: `Bring ${proposedName} together`,
      reason: `These ${members.length} ungrouped tabs each have a ${category.names.en.toLowerCase()} category clue in their ${source}, such as ${[
        ...cues.values(),
      ]
        .slice(0, 3)
        .map((cue) => `“${cue}”`)
        .join(", ")}. They are in the same window.`,
      signal: "category",
      priority: 60,
      category: category.id,
      namePreference: preference,
      nameLanguage: language,
    });
  }
  return proposals.sort(
    (a, b) =>
      b.priority - a.priority ||
      b.tabs.length - a.tabs.length ||
      a.tabs[0].windowId - b.tabs[0].windowId ||
      a.tabs[0].id - b.tabs[0].id,
  );
}
