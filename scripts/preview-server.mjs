import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";

/** Source-only visual preview. No extension installation or browser profile access. */
export async function createPreviewServer(root) {
  const allowed = new Map([
    ["/index.html", "text/html"],
    ["/styles.css", "text/css"],
    ["/app.mjs", "text/javascript"],
    ["/local-ai.mjs", "text/javascript"],
    ["/proactive-names.mjs", "text/javascript"],
    ["/ai-status-watch.mjs", "text/javascript"],
    ["/history-index.mjs", "text/javascript"],
    ["/core.mjs", "text/javascript"],
    ["/topic-evidence.mjs", "text/javascript"],
    ["/metadata-groups.mjs", "text/javascript"],
    ["/grouping-context.mjs", "text/javascript"],
    ["/existing-group-matches.mjs", "text/javascript"],
    ["/group-discovery.mjs", "text/javascript"],
    ["/proactive-discovery.mjs", "text/javascript"],
    ...[16, 32, 48, 128].map((size) => [
      `/icons/icon-${size}.png`,
      "image/png",
    ]),
  ]);
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    const type = allowed.get(pathname);
    if (!type) {
      response.writeHead(404).end();
      return;
    }
    try {
      const bytes = await fs.readFile(path.join(root, "extension", pathname));
      response.writeHead(200, {
        "Content-Type": type,
        "Cache-Control": "no-store",
      });
      response.end(bytes);
    } catch {
      response.writeHead(500).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/index.html`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
