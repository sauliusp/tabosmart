import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
await import("./check.mjs");
const root = path.resolve(import.meta.dirname, ".."),
  extension = path.join(root, "extension"),
  dist = path.join(root, "dist");
const manifest = JSON.parse(
  await fs.readFile(path.join(extension, "manifest.json"), "utf8"),
);
await fs.mkdir(dist, { recursive: true });
const name = `tabosmart-${manifest.version}-chrome.zip`,
  output = path.join(dist, name);
await fs.rm(output, { force: true });
execFileSync("zip", ["-qr", output, ".", "-x", "*.DS_Store"], {
  cwd: extension,
});
const bytes = await fs.readFile(output);
const files = execFileSync("unzip", ["-Z1", output], { encoding: "utf8" })
  .trim()
  .split("\n");
if (
  !files.includes("manifest.json") ||
  files.some((f) => f.includes("node_modules") || f.includes("qa/"))
)
  throw new Error("Invalid package contents");
const report = {
  package: name,
  version: manifest.version,
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  files,
  builtAt: new Date().toISOString(),
};
await fs.writeFile(
  path.join(dist, "package-report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
const sourceName = `tabosmart-${manifest.version}-source.zip`;
const sourceOutput = path.join(dist, sourceName);
await fs.rm(sourceOutput, { force: true });
// Keep the distributable source complete without including local browser records,
// private voice intermediates, dependency caches, or nested repository metadata.
const excludedNames = new Set([
  "node_modules", ".git", ".DS_Store", "dist", ".next", ".vinext", ".wrangler",
]);
const excludedPaths = new Set([
  "marketing/store",
  "marketing/community-launch/video/audio",
  "marketing/community-launch/video/frames",
  "marketing/community-launch/video/source/render-command.json",
  "marketing/community-launch/video/source/media-metadata.json",
]);
const sourceFiles = [];
async function collectSource(relative) {
  const base = path.basename(relative);
  if (excludedNames.has(base) || excludedPaths.has(relative) ||
      base.startsWith(".env") || /\.(?:log|pem|tsbuildinfo)$/.test(base)) return;
  const stat = await fs.lstat(path.join(root, relative));
  if (stat.isDirectory()) {
    for (const entry of await fs.readdir(path.join(root, relative))) {
      await collectSource(`${relative}/${entry}`);
    }
  } else if (stat.isFile()) sourceFiles.push(relative);
}
for (const relative of [
  "extension", "tests", "scripts", "docs", "marketing", "website", ".github",
  "package.json", "package-lock.json", "README.md", "ARTIFACTS.md", ".gitignore",
]) await collectSource(relative);
execFileSync("zip", ["-q", sourceOutput, "-@"], {
  cwd: root,
  input: sourceFiles.sort().join("\n") + "\n",
});
const sourceBytes = await fs.readFile(sourceOutput);
await fs.writeFile(
  path.join(dist, "source-report.json"),
  JSON.stringify(
    {
      package: sourceName,
      bytes: sourceBytes.length,
      sha256: createHash("sha256").update(sourceBytes).digest("hex"),
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Source and review assets: ${sourceName} (${sourceBytes.length} bytes)`,
);
