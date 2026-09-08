import { test } from "node:test";
import assert from "node:assert/strict";
import { faviconURL } from "../extension/favicons.mjs";
test("favicon requests stay on the extension's local Chrome endpoint", () => {
  const page = "https://example.org/work?q=a&private=yes#section";
  const icon = new URL(faviconURL(page, "chrome-extension://abcdefghijklmnop/"));
  assert.equal(icon.origin, "null");
  assert.equal(icon.protocol, "chrome-extension:");
  assert.equal(icon.hostname, "abcdefghijklmnop");
  assert.equal(icon.pathname, "/_favicon/");
  assert.equal(icon.searchParams.get("pageUrl"), page);
  assert.equal(icon.searchParams.get("size"), "32");
});
test("unsupported pages and preview environments never trigger remote favicon loads", () => {
  for (const page of [null, "invalid", "file:///secret", "javascript:alert(1)", "chrome://settings"]) assert.equal(faviconURL(page, "chrome-extension://abc/"), "");
  assert.equal(faviconURL("https://example.org", "https://remote.example"), "");
  assert.equal(faviconURL("https://example.org", undefined), "");
});
