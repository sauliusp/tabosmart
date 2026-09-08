/** Local metadata vocabulary, never page reading or remote classification. */
export const NAME_LANGUAGES = Object.freeze({
  auto: "Automatic from tab titles",
  en: "English",
  lt: "Lietuvių",
  de: "Deutsch",
  fr: "Français",
  es: "Español",
  pl: "Polski",
  ja: "日本語",
});
export const PROMPT_LANGUAGES = new Set(["en", "ja", "es", "de", "fr"]);
export const normalizeText = (value) =>
  String(value || "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
const segmenter =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter("und", { granularity: "word" })
    : null;
export function textWords(value) {
  const text = String(value || "").normalize("NFC");
  return segmenter
    ? [...segmenter.segment(text)]
        .filter((x) => x.isWordLike)
        .map((x) => x.segment)
    : text.match(/[\p{L}\p{N}]+/gu) || [];
}
const GENERIC = `about after again also before chrome click dashboard document docs edit example file files from google have home into just learn login more new news open page pages read search sign site smart tab tabs that their then there these this title untitled using view web website what when which with work your youtube latest today live online official update updates story stories read more all and the for this article guide guides reference references download welcome project research notes plan planning ideas review tutorial help introduction tips best top great videos video
ir ar yra apie kaip kas kad tai bei nuo iki su del per prie dar jau tik visi visos daugiau naujas nauja nauji naujos naujausi naujausios naujienos naujienu zinios ziniu portalas portalu puslapis pradinis pagrindinis prisijungti skaityti siandien tiesiogiai oficialus
und oder die der das den dem des mit fur von zum zur ein eine ist sind mehr neue neu nachrichten aktuell aktuelle seite startseite anmelden lesen heute
et ou le la les des du de un une pour dans avec sur est sont plus nouveau nouvelles actualites accueil connexion lire aujourd hui
el los las una uno unos unas con para por del es son mas nuevo noticias actualidad inicio entrar leer hoy
oraz lub jest sa jak dla przez wiadomosci aktualnosci nowy nowe strona glowna zaloguj czytaj dzisiaj
и в на с по для это как что новости главная читать сегодня все
最新 ニュース ホーム ログイン 公式 今日 記事 ガイド 詳細`;
const STOP = new Set(textWords(GENERIC).map(normalizeText));
function hostname(tab) {
  try {
    return new URL(tab.url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
export function titleData(tab) {
  const brands = new Set(
    [hostname(tab), ...hostname(tab).split(/[.\-]/)].map(normalizeText),
  );
  const words = new Map();
  for (const word of textWords(String(tab.title || "").slice(0, 300))) {
    const key = normalizeText(word);
    if (
      [...key].length < 2 ||
      /^\d+$/.test(key) ||
      STOP.has(key) ||
      brands.has(key)
    )
      continue;
    if (!words.has(key)) words.set(key, word);
  }
  return words;
}
const languageClues = {
  en: "the and for with your how choosing project plans materials budget learning guide from",
  lt: "ir bei kaip yra kad savo lietuvoje lietuvos naujienos žinios žinių naujienų naujausios naujausi naujienomis planai medžiagos pasaulyje",
  de: "und der die das den dem des ein eine ist sind für mit aus über wie bauen deutschland",
  fr: "avec pour les des une dans sur comment france",
  es: "los las una con para cómo españa",
  pl: "oraz jest dla jak polska świecie wiadomości",
  ja: "ニュース 日本 料理 レシピ 方法",
};
export function titleLanguage(title) {
  if (/[ėįųū]/iu.test(title)) return "lt";
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(title)) return "ja";
  if (
    /[\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Devanagari}\p{Script=Hangul}]/u.test(
      title,
    )
  )
    return "unsupported";
  const words = textWords(title).map(normalizeText),
    text = words.join(" ");
  if (/\p{Script=Han}/u.test(title)) return "unsupported";
  const scores = Object.fromEntries(
    Object.keys(languageClues).map((lang) => [lang, 0]),
  );
  for (const [lang, clues] of Object.entries(languageClues))
    scores[lang] += new Set(
      textWords(clues)
        .map(normalizeText)
        .filter((word) => words.includes(word)),
    ).size;
  const sorted = Object.entries(scores).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  return sorted[0][1] >= 2 && sorted[0][1] > sorted[1][1]
    ? sorted[0][0]
    : "und";
}
export function namingPlan(tabs, preference = "auto") {
  const detected = tabs.map((tab) =>
    titleLanguage(String(tab.title || "").slice(0, 300)),
  );
  const counts = new Map();
  for (const lang of detected)
    if (!["und", "unsupported"].includes(lang))
      counts.set(lang, (counts.get(lang) || 0) + 1);
  const ranked = [...counts].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  const known = [...counts.values()].reduce((a, b) => a + b, 0);
  const dominant =
    ranked[0]?.[1] >= 2 && ranked[0][1] / Math.max(1, known) >= 0.6
      ? ranked[0][0]
      : null;
  const language =
    preference !== "auto" && Object.hasOwn(NAME_LANGUAGES, preference)
      ? preference
      : dominant || "en";
  const inputLanguages = [
    ...new Set([
      "en",
      ...detected.filter((lang) => lang !== "und" && lang !== "unsupported"),
    ]),
  ].sort();
  const modelEligible =
    PROMPT_LANGUAGES.has(language) &&
    detected.every((lang) => lang !== "unsupported") &&
    inputLanguages.every((lang) => PROMPT_LANGUAGES.has(lang));
  return {
    language,
    inputLanguages,
    modelEligible,
    basis:
      preference !== "auto" && Object.hasOwn(NAME_LANGUAGES, preference)
        ? "chosen"
        : dominant
          ? "titles"
          : "neutral-default",
  };
}
/** Shared lexical anchors form a coherent cluster, never a transitive chain. */
export function discoverMetadataGroups(tabs, preference = "auto") {
  const ordered = [...tabs].sort(
    (a, b) => a.windowId - b.windowId || a.id - b.id,
  );
  const records = ordered.map((tab) => ({
    tab,
    host: hostname(tab),
    words: titleData(tab),
  }));
  const seenAnchors = new Set();
  const clusters = new Map(),
    siteCounts = new Map();
  for (const tab of ordered) {
    const key = `${tab.windowId}:${hostname(tab)}`;
    siteCounts.set(key, (siteCounts.get(key) || 0) + 1);
  }
  const inverted = new Map();
  records.forEach((row, index) => {
    for (const word of row.words.keys()) {
      const key = JSON.stringify([row.tab.windowId, word]);
      const ids = inverted.get(key) || [];
      ids.push(index);
      inverted.set(key, ids);
    }
  });
  for (let i = 0; i < records.length; i++) {
    const a = records[i],
      neighbors = new Set();
    for (const word of a.words.keys())
      for (const j of inverted.get(JSON.stringify([a.tab.windowId, word])) ||
        [])
        if (j > i) neighbors.add(j);
    for (const j of [...neighbors].sort((a, b) => a - b)) {
      const b = records[j];
      if (
        a.host === b.host &&
        siteCounts.get(`${a.tab.windowId}:${a.host}`) >= 3
      )
        continue;
      const common = [...a.words.keys()]
        .filter((word) => b.words.has(word))
        .sort();
      if (common.length < 2 && !(common.length === 1 && a.host === b.host))
        continue;
      const key = JSON.stringify([
        a.tab.windowId,
        common,
        common.length === 1 ? a.host : null,
      ]);
      if (seenAnchors.has(key)) continue;
      seenAnchors.add(key);
      const members = records
        .filter(
          (row) =>
            row.tab.windowId === a.tab.windowId &&
            (common.length >= 2 || row.host === a.host) &&
            common.every((word) => row.words.has(word)),
        )
        .map((row) => row.tab);
      const plan = namingPlan(members, preference);
      const display = [...a.words.keys()]
        .filter((word) => common.includes(word))
        .slice(0, 3);
      const name = display
        .map((word) => a.words.get(word))
        .join(" ")
        .slice(0, 60);
      clusters.set(key, {
        tabs: members,
        proposedName: name.charAt(0).toUpperCase() + name.slice(1),
        namePreference: preference,
        nameLanguage: plan.language,
        signal: "title",
        title: `Bring ${name} together`,
        reason: `${members.length} ungrouped tabs from ${new Set(members.map(hostname)).size} sites share the title ${display.length === 1 ? "word" : "words"} “${display
          .slice(0, 2)
          .map((word) => a.words.get(word))
          .join("” and “")}”. They are in the same window.`,
        anchors: common,
      });
    }
  }
  const titleGroups = [...clusters.values()].sort(
    (a, b) =>
      b.tabs.length - a.tabs.length ||
      b.anchors.length - a.anchors.length ||
      a.tabs[0].windowId - b.tabs[0].windowId ||
      a.tabs[0].id - b.tabs[0].id ||
      a.anchors.join().localeCompare(b.anchors.join()),
  );
  return titleGroups;
}
