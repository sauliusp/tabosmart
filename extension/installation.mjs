const WELCOME_KEY = "tabosmart.installWelcomeShown";

// Chrome fires onInstalled for updates too. Only a fresh installation gets a tab.
export function createInstallationWelcome(api) {
  let pending;
  return function installed(details) {
    if (details?.reason !== "install") return Promise.resolve();
    if (pending) return pending;
    pending = (async () => {
      if ((await api.storage.local.get(WELCOME_KEY))[WELCOME_KEY]) return;
      const url = api.runtime.getURL("welcome.html");
      const tabs = await api.tabs.query({});
      if (!tabs.some((tab) => !tab.incognito && tab.url === url)) {
        await api.tabs.create({ url, active: true });
      }
      await api.storage.local.set({ [WELCOME_KEY]: true });
    })().finally(() => { pending = null; });
    return pending;
  };
}
