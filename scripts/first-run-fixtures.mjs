import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";

// Static test content only. This script does not control a browser or access AI.
const root = path.resolve(import.meta.dirname, "..");
const run = "first-run-20260908";
const port = 8766;
const fixtures = [];
const pages = new Map();
const esc = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
function add(window, host, slug, label, purpose, manualState = "ordinary") {
  const pathname = `/${run}/${window}/${slug}`;
  const id = `T${String(fixtures.length + 1).padStart(2, "0")}`;
  const url = `http://${host}:${port}${pathname}`;
  const parsed = new URL(url);
  const key = parsed.pathname + parsed.search;
  // Unique fixture marker avoids adding shared title words to the grouping test.
  const title = pages.get(key)?.title || `Tabosmart${id} QA · ${label}`;
  fixtures.push({ id, window, url, title, purpose, manualState });
  if (!pages.has(key))
    pages.set(key, {
      title,
      label,
      purpose:
        manualState === "draft"
          ? "Exact URL duplicate; vary the disposable draft independently in each copy"
          : purpose,
      manualState,
    });
}
for (const window of ["A", "B"]) {
  for (const topic of [
    "plans",
    "materials",
    "budget",
    "lighting",
    "furniture",
    "schedule",
  ])
    add(
      window,
      "127.0.0.1",
      `studio/${topic}`,
      `Garden studio ${topic}`,
      "same-site related tabs",
    );
  for (const topic of [
    "route",
    "hotels",
    "walks",
    "packing",
    "weather",
    "calendar",
  ])
    add(
      window,
      "localhost",
      `trip/${topic}`,
      `Baltic trip ${topic}`,
      "second same-site project",
    );
  for (const [index, project] of [
    "Website refresh",
    "Workshop agenda",
    "Reading shortlist",
    "Kitchen planning",
  ].entries()) {
    add(
      window,
      "localhost",
      `pair/${index}/notes`,
      `${project} notes`,
      "related title pair across two sites",
    );
    add(
      window,
      "127.0.0.1",
      `pair/${index}/references`,
      `${project} references`,
      "related title pair across two sites",
    );
  }
  for (let copy = 1; copy <= 3; copy++)
    add(
      window,
      "127.0.0.1",
      "duplicate/draft",
      "Project draft duplicate",
      `exact URL copy ${copy}; vary synthetic draft text manually`,
      "draft",
    );
  for (const suffix of [
    "?phase=research",
    "?phase=planning",
    "?phase=planning#notes",
  ])
    add(
      window,
      "localhost",
      `variants/reference${suffix}`,
      "Project reference variants",
      "query and fragment identities remain distinct",
    );
  for (const state of ["protected", "pinned", "audible", "active"])
    add(
      window,
      "127.0.0.1",
      `exclusion/${state}`,
      `Safety fixture ${state}`,
      "explicit exclusion from relevant suggestions/closure",
      state,
    );
  for (let i = 1; i <= 2; i++)
    add(
      window,
      "localhost",
      `existing-group/${i}`,
      `Existing project group ${i}`,
      "pre-group these fixture tabs only",
      "grouped",
    );
}
const manifest = {
  run,
  preparedAt: new Date().toISOString(),
  targetSourceVersion: JSON.parse(
    await fs.readFile(path.join(root, "extension/manifest.json"), "utf8"),
  ).version,
  status: "Prepared only; no fixture tabs opened by this script",
  browserActions: 0,
  aiCalls: 0,
  modelResets: 0,
  windows: ["A", "B"],
  count: fixtures.length,
  baseURL: `http://127.0.0.1:${port}`,
  fixtures,
};
await fs.mkdir(path.join(root, "qa"), { recursive: true });
await fs.writeFile(
  path.join(root, "qa/first-run-fixtures.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
const links = fixtures
  .map(
    (f) =>
      `<li><a href="${esc(f.url)}" target="_blank" rel="noopener">${f.id} · Window ${f.window} · ${esc(f.title)}</a><br><small>${esc(f.purpose)}; planned state: ${esc(f.manualState)}</small></li>`,
  )
  .join("");
function render(page) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(page?.title || "Tabosmart QA · First-run fixture index")}</title><style>body{max-width:850px;margin:48px auto;padding:24px;font:17px/1.6 system-ui;color:#253e32;background:#f4f6f1}a{color:#245a3a}li{margin:16px 0}textarea{display:block;width:100%;min-height:160px;font:inherit}small{color:#566958}.note{padding:20px;background:#e5edde;border-radius:12px}</style><main><p>DISPOSABLE SYNTHETIC TABOSMART QA FIXTURE</p><h1>${esc(page?.label || "64 tabs, two dedicated test windows")}</h1><p>${esc(page?.purpose || "Prepared links only. Open in dedicated test windows once real-browser access and model-reset scope are verified.")}</p><p class="note">This page contains fictional test content. No model, extension, browser-control or telemetry APIs are called. Any draft text is disposable and stays in this page. It is safe to close after recording the test.</p>${page?.manualState === "draft" ? "<label>Disposable unsaved draft<textarea>Fixture-only project draft. Change this text independently in duplicate copies.</textarea></label>" : ""}${page?.manualState === "audible" ? '<p>Play this quiet local tone only during the audible-tab scenario, then pause it.</p><audio controls loop preload="none" src="/tone.wav"></audio>' : ""}${page ? '<p><a href="/">Fixture index</a></p><p>PAGE_BODY_SENTINEL_DO_NOT_USE_FOR_TAB_SUGGESTIONS</p>' : `<ol>${links}</ol>`}</main></html>`;
}
function tone() {
  const samples = 8000,
    bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++)
    bytes.writeInt16LE(
      Math.round(200 * Math.sin((2 * Math.PI * 220 * i) / 8000)),
      44 + i * 2,
    );
  return bytes;
}
const server = http.createServer((request, response) => {
  const parsed = new URL(request.url, "http://127.0.0.1");
  const pathname = parsed.pathname;
  const page = pages.get(pathname + parsed.search);
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; media-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  };
  if (!["GET", "HEAD"].includes(request.method)) {
    response.writeHead(405, headers).end();
    return;
  }
  if (pathname === "/tone.wav") {
    response
      .writeHead(200, { ...headers, "Content-Type": "audio/wav" })
      .end(request.method === "HEAD" ? undefined : tone());
    return;
  }
  response.writeHead(page || pathname === "/" ? 200 : 404, {
    ...headers,
    "Content-Type": "text/html; charset=utf-8",
  });
  response.end(
    request.method === "HEAD"
      ? undefined
      : page || pathname === "/"
        ? render(page)
        : "Fixture not found",
  );
});
if (process.argv.includes("--serve")) {
  server.listen(port, "127.0.0.1", () =>
    console.log(
      `Prepared ${fixtures.length} fixtures. Server: ${manifest.baseURL}. No browser tabs opened.`,
    ),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => server.close(() => process.exit(0)));
} else {
  // Validate static fixture delivery over HTTP without starting or controlling any browser.
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    for (const fixture of fixtures) {
      const url = new URL(fixture.url);
      url.hostname = "127.0.0.1";
      url.port = String(server.address().port);
      const response = await fetch(url);
      const body = await response.text();
      if (
        response.status !== 200 ||
        !body.includes(`<title>${esc(fixture.title)}</title>`)
      )
        throw new Error(`Fixture failed: ${fixture.id}`);
    }
    const report = {
      checkedAt: new Date().toISOString(),
      fixturesPassed: fixtures.length,
      failures: 0,
      method: "Node HTTP requests only",
      browserActions: 0,
      aiCalls: 0,
      modelResets: 0,
      realE2EStatus: "Blocked before reset; not executed",
    };
    await fs.writeFile(
      path.join(root, "qa/first-run-fixture-checks.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
