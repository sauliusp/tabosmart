import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
const root = path.resolve(import.meta.dirname, ".."),
  dir = path.join(root, "extension");
const manifest = JSON.parse(
  await fs.readFile(path.join(dir, "manifest.json"), "utf8"),
);
assert.equal(manifest.name, "Tabosmart");
assert.equal(manifest.manifest_version, 3);
assert(manifest.description.length <= 132);
assert.deepEqual([...manifest.permissions].sort(), [
  "alarms",
  "favicon",
  "history",
  "storage",
  "tabGroups",
  "tabs",
]);
assert(
  !manifest.optional_permissions &&
    !manifest.host_permissions &&
    !manifest.optional_host_permissions &&
    !manifest.content_scripts &&
    !manifest.externally_connectable,
);
assert.equal(manifest.incognito, "not_allowed");
assert(
  manifest.content_security_policy.extension_pages.includes(
    "connect-src 'none'",
  ),
);
for (const file of [
  manifest.background.service_worker,
  "index.html",
  "welcome.html",
  "welcome.css",
  "installation.mjs",
  "styles.css",
  "app.mjs",
  "core.mjs",
  "topic-evidence.mjs",
  "metadata-groups.mjs",
  "grouping-context.mjs",
  "existing-group-matches.mjs",
  "group-discovery.mjs",
  "proactive-discovery.mjs",
  "local-ai.mjs",
  "proactive-names.mjs",
  "workspace-view.mjs",
  "toolbar-state.mjs",
  "history-index.mjs",
  "ai-status-watch.mjs",
  ...Object.values(manifest.icons),
])
  await fs.access(path.join(dir, file));
for (const file of await fs.readdir(dir)) {
  if (file.endsWith(".mjs"))
    execFileSync(process.execPath, ["--check", path.join(dir, file)]);
  if (/\.(mjs|css|html)$/.test(file)) {
    const text = await fs.readFile(path.join(dir, file), "utf8");
    assert(
      !/\bfetch\s*\(|XMLHttpRequest|new WebSocket|sendBeacon|(?:chrome|api)\.history\.(?:addUrl|deleteAll|deleteRange|deleteUrl)|chrome\.bookmarks|chrome\.scripting|Summarizer|eval\s*\(/.test(
        text,
      ),
      `Unexpected permission, network or remote execution surface in ${file}`,
    );
    assert(!text.includes("\u2014"), `Em dash in ${file}`);
  }
}
console.log(
  "Manifest, permission scope, packaged file references, JS syntax and absence of network/page-reading APIs verified.",
);
