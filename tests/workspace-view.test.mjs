import test from "node:test";
import assert from "node:assert/strict";
import { createWorkspaceView } from "../extension/workspace-view.mjs";

const URL = "chrome-extension://tabosmart-test/index.html";
const tab = (id, patch = {}) => ({
  id,
  windowId: 7,
  url: `https://page${id}.test/`,
  active: false,
  incognito: false,
  ...patch,
});
const sender = (id, patch = {}) => ({
  id: "tabosmart-test",
  url: URL,
  tab: { id },
  ...patch,
});
function fixture(initial = [tab(1, { active: true })], session = {}) {
  const tabs = new Map(initial.map((item) => [item.id, structuredClone(item)]));
  const calls = [];
  let nextId = 100;
  const hooks = { get: null, create: null, remove: null };
  const api = {
    runtime: {
      id: "tabosmart-test",
      getURL: (path) => `chrome-extension://tabosmart-test/${path}`,
    },
    storage: {
      session: {
        async get(key) {
          return { [key]: structuredClone(session[key]) };
        },
        async set(data) {
          Object.assign(session, structuredClone(data));
        },
      },
    },
    tabs: {
      async query(query) {
        calls.push(["query", query]);
        return [...tabs.values()]
          .filter(
            (item) =>
              query.windowId === undefined || item.windowId === query.windowId,
          )
          .map((item) => structuredClone(item));
      },
      async get(id) {
        await hooks.get?.(id);
        const item = tabs.get(id);
        if (!item) throw new Error("Missing tab");
        return structuredClone(item);
      },
      async create(props) {
        calls.push(["create", structuredClone(props)]);
        if (hooks.create) return hooks.create(props);
        const item = tab(nextId++, {
          url: props.url || "chrome://newtab/",
          windowId: props.windowId,
          active: props.active,
        });
        tabs.set(item.id, item);
        if (item.active)
          for (const other of tabs.values())
            if (other.windowId === item.windowId && other.id !== item.id)
              other.active = false;
        return structuredClone(item);
      },
      async update(id, patch) {
        calls.push(["activate", id, patch]);
        const item = tabs.get(id);
        if (!item) throw new Error("Missing tab");
        Object.assign(item, patch);
        if (patch.active)
          for (const other of tabs.values())
            if (other.windowId === item.windowId && other.id !== id)
              other.active = false;
        return structuredClone(item);
      },
      async remove(id) {
        calls.push(["remove", id]);
        await hooks.remove?.(id);
        tabs.delete(id);
      },
    },
    windows: {
      async update(id, props) {
        calls.push(["window", id, props]);
      },
    },
  };
  return {
    api,
    tabs,
    calls,
    hooks,
    session,
    view: () => createWorkspaceView(api),
  };
}

test("rapid repeated opens create one workspace and then focus that same tab", async () => {
  const f = fixture(),
    view = f.view();
  const opened = await Promise.all(
    Array.from({ length: 12 }, () => view.open(tab(1))),
  );
  assert.equal(new Set(opened.map((item) => item.tabId)).size, 1);
  assert.equal(opened[0].reused, false);
  assert.ok(opened.slice(1).every((item) => item.reused));
  assert.equal(f.calls.filter(([type]) => type === "create").length, 1);
  assert.deepEqual(f.calls.find(([type]) => type === "create")[1], {
    url: URL,
    windowId: 7,
    active: true,
  });
});

test("same-window existing workspace is preferred and other windows are left unchanged", async () => {
  const f = fixture([
    tab(1, { active: true }),
    tab(2, { windowId: 8, url: URL }),
    tab(3, { url: URL + "?view=saved#top" }),
  ]);
  assert.deepEqual(await f.view().open(tab(1)), {
    tabId: 3,
    windowId: 7,
    reused: true,
  });
  assert.deepEqual(
    f.calls.filter(([type]) => ["activate", "window"].includes(type)),
    [
      ["activate", 3, { active: true }],
      ["window", 7, { focused: true }],
    ],
  );
  assert.equal(
    f.calls.some(([type]) => type === "create"),
    false,
  );
});

test("known workspace in another window is reused while close returns only within its own window", async () => {
  const f = fixture([
      tab(1, { active: true }),
      tab(2, { windowId: 8, active: true }),
      tab(3, { windowId: 8, url: URL }),
    ]),
    view = f.view();
  assert.equal((await view.open(tab(1))).tabId, 3);
  f.calls.length = 0;
  const closed = await view.close(sender(3));
  assert.equal(closed.focusedTabId, 2);
  assert.deepEqual(
    f.calls.filter(([type]) =>
      ["remove", "activate", "window", "create"].includes(type),
    ),
    [
      ["remove", 3],
      ["activate", 2, { active: true }],
    ],
  );
  assert.ok(f.tabs.has(1));
});

test("open accepts pending own navigation without creating a duplicate", async () => {
  const f = fixture([
    tab(1),
    tab(2, { url: "", pendingUrl: URL + "#loading" }),
  ]);
  assert.equal((await f.view().open(tab(1))).tabId, 2);
  assert.equal(
    f.calls.some(([type]) => type === "create"),
    false,
  );
});

test("own URL matching permits only query and fragment suffixes", async () => {
  for (const suffix of ["", "?view=saved", "#top", "?view=saved#top"]) {
    const f = fixture([tab(1), tab(2, { url: URL + suffix })]);
    assert.equal(
      (await f.view().close(sender(2, { url: URL + suffix }))).closed,
      true,
    );
    assert.deepEqual(
      f.calls.filter(([type]) => type === "remove"),
      [["remove", 2]],
    );
  }
  for (const url of [
    URL + "/other",
    URL + ".other",
    URL.replace("index.html", "other.html"),
    URL.replace("tabosmart-test", "another-extension"),
    "https://example.test/index.html",
    URL.replace("index.html", "%69ndex.html"),
  ]) {
    const f = fixture([tab(1), tab(2, { url })]);
    await assert.rejects(f.view().close(sender(2)), {
      code: "INVALID_WORKSPACE",
    });
    assert.equal(
      f.calls.some(([type]) => type === "remove"),
      false,
    );
  }
});

test("untrusted sender, missing sender tab, incognito, and pending foreign navigation cannot close", async () => {
  for (const source of [
    sender(2, { id: "other-extension" }),
    sender(2, { url: URL + "/fake" }),
    sender(2, { tab: undefined }),
    sender(2, { tab: { id: 2, incognito: true } }),
    sender(1),
  ]) {
    const f = fixture([tab(1), tab(2, { url: URL })]);
    await assert.rejects(f.view().close(source), { code: "INVALID_WORKSPACE" });
    assert.equal(
      f.calls.some(([type]) => ["remove", "create", "activate"].includes(type)),
      false,
    );
  }
  for (const patch of [
    { incognito: true },
    { pendingUrl: "https://unrelated.test/" },
  ]) {
    const f = fixture([tab(1), tab(2, { url: URL, ...patch })]);
    await assert.rejects(f.view().close(sender(2)), {
      code: "INVALID_WORKSPACE",
    });
    assert.equal(f.tabs.size, 2);
  }
});

test("closing revalidates live identity immediately before removal", async () => {
  const f = fixture([tab(1), tab(2, { url: URL })]);
  let reads = 0;
  f.hooks.get = async (id) => {
    if (id === 2 && ++reads === 2) f.tabs.get(2).url = "https://changed.test/";
  };
  await assert.rejects(f.view().close(sender(2)), {
    code: "INVALID_WORKSPACE",
  });
  assert.equal(
    f.calls.some(([type]) => type === "remove"),
    false,
  );
});

test("last-tab closure creates a same-window New Tab before removing only the workspace", async () => {
  const f = fixture([tab(2, { url: URL, active: true })]);
  const closed = await f.view().close(sender(2));
  assert.equal(closed.createdReturnTab, true);
  assert.equal(closed.focusedTabId, 100);
  assert.deepEqual(
    f.calls.filter(([type]) =>
      ["create", "remove", "activate", "window"].includes(type),
    ),
    [
      ["create", { windowId: 7, active: false }],
      ["remove", 2],
      ["activate", 100, { active: true }],
    ],
  );
  assert.equal(f.tabs.get(100).url, "chrome://newtab/");
});

test("failed New Tab creation keeps the last workspace and window intact", async () => {
  const f = fixture([tab(2, { url: URL })]);
  f.hooks.create = () => {
    throw new Error("Chrome refused creation");
  };
  await assert.rejects(f.view().close(sender(2)), /refused creation/);
  assert.ok(f.tabs.has(2));
  assert.equal(
    f.calls.some(([type]) => type === "remove"),
    false,
  );
});

test("removed, navigated, moved, or unsafe return targets are never focused", async () => {
  for (const mutate of [
    (tabs) => tabs.delete(1),
    (tabs) => {
      tabs.get(1).url = "https://changed.test/";
    },
    (tabs) => {
      tabs.get(1).windowId = 9;
    },
    (tabs) => {
      tabs.get(1).incognito = true;
    },
    (tabs) => {
      tabs.get(1).url = URL;
    },
    (tabs) => {
      tabs.get(1).pendingUrl = "https://pending.test/";
    },
  ]) {
    const f = fixture([tab(1, { active: true }), tab(2, { url: URL }), tab(3)]),
      view = f.view();
    await view.open(tab(1));
    mutate(f.tabs);
    f.calls.length = 0;
    assert.equal((await view.close(sender(2))).focusedTabId, null);
    assert.deepEqual(
      f.calls.filter(([type]) =>
        ["remove", "activate", "window", "create"].includes(type),
      ),
      [["remove", 2]],
    );
  }
});

test("return target survives worker recreation with only bounded tab/window IDs in session storage", async () => {
  const f = fixture([tab(1, { active: true }), tab(2, { url: URL })]);
  await f.view().open(tab(1));
  const stored = JSON.stringify(f.session);
  assert.equal(/https:|chrome-extension:|title|page1/.test(stored), false);
  assert.equal((await f.view().close(sender(2))).focusedTabId, 1);
});

test("open and close are serialized and a rejected close cannot poison later toolbar opens", async () => {
  const f = fixture([tab(1, { active: true }), tab(2, { url: URL })]),
    view = f.view();
  const rejected = view.close(sender(1));
  const opened = view.open(tab(1));
  await assert.rejects(rejected, { code: "INVALID_WORKSPACE" });
  assert.equal((await opened).tabId, 2);
  const outcomes = await Promise.allSettled([
    view.close(sender(2)),
    view.close(sender(2)),
    view.open(tab(1)),
  ]);
  assert.equal(outcomes[0].status, "fulfilled");
  assert.equal(outcomes[1].status, "rejected");
  assert.equal(outcomes[2].status, "fulfilled");
  assert.equal(f.calls.filter(([type]) => type === "remove").length, 1);
  assert.equal(
    [...f.tabs.values()].filter((item) => item.url === URL).length,
    1,
  );
});

test("incognito invocation and absence of any regular window cannot create a workspace", async () => {
  const f = fixture([tab(1, { incognito: true })]);
  await assert.rejects(f.view().open(tab(1, { incognito: true })), {
    code: "INVALID_WORKSPACE",
  });
  await assert.rejects(f.view().open(), { code: "ACTION_FAILED" });
  assert.equal(
    f.calls.some(([type]) => type === "create"),
    false,
  );
});
