// Only Chrome's profile-local favicon endpoint. No remote icon service or host access.
export function faviconURL(pageURL, extensionBase) {
  try {
    const page = new URL(pageURL);
    const base = new URL(extensionBase);
    if (!["http:", "https:"].includes(page.protocol) || base.protocol !== "chrome-extension:") return "";
    const icon = new URL("/_favicon/", base);
    icon.searchParams.set("pageUrl", page.href);
    icon.searchParams.set("size", "32");
    return icon.href;
  } catch { return ""; }
}
