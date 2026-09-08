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
execFileSync(
  "zip",
  [
    "-qr",
    sourceOutput,
    "extension",
    "tests",
    "scripts",
    "docs",
    "marketing",
    "qa",
    "package.json",
    "package-lock.json",
    "README.md",
    "ARTIFACTS.md",
    ".gitignore",
    "-x",
    "*.DS_Store",
    "qa/browser-failure.json",
    "qa/screenshots/failure.png",
  ],
  { cwd: root },
);
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
