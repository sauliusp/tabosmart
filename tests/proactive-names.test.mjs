import test from "node:test";
import assert from "node:assert/strict";
import {
  createProactiveNames,
  evidenceKeyFor,
} from "../extension/proactive-names.mjs";

const enabled = { enabled: true, available: true, visible: true };
const proposal = (id = "g1") => ({
  id,
  type: "group",
  signal: "title",
  proposedName: "Mercury",
  reason: "Shared title words: mercury project.",
  tabs: [
    {
      id: 1,
      title: "Mercury project API",
      url: "https://a.test/api?exact=1",
      windowId: 1,
      groupId: -1,
    },
    {
      id: 2,
      title: "Mercury project tutorial",
      url: "https://b.test/tutorial",
      windowId: 1,
      groupId: -1,
    },
  ],
});
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("automatic generation needs observation/AI enablement, actual availability, visibility, and a group", async () => {
  let calls = 0;
  const controller = createProactiveNames({
    generate: async () => {
      calls++;
      return "Mercury work";
    },
  });
  for (const field of ["enabled", "available", "visible"])
    await controller.sync([proposal()], { ...enabled, [field]: false });
  await controller.sync(
    [
      { ...proposal(), type: "inactive" },
      { ...proposal(), type: "duplicate" },
    ],
    enabled,
  );
  assert.equal(calls, 0);
  assert.equal(controller.getName(proposal()), null);
});

test("automatic names are cached by exact evidence, bounded per interface, and carry only actual AI provenance", async () => {
  const changes = [];
  let calls = 0;
  const controller = createProactiveNames({
    maxAutomaticAttempts: 2,
    onName: (result) => changes.push(result),
    generate: async () => {
      calls++;
      return "Mercury work";
    },
  });
  const groups = Array.from({ length: 4 }, (_, i) => proposal(`g${i}`));
  await controller.sync(groups, enabled);
  await controller.sync(groups, enabled);
  assert.equal(calls, 2);
  assert.equal(changes.length, 2);
  assert.deepEqual(controller.getName(groups[0]), {
    name: "Mercury work",
    evidenceKey: evidenceKeyFor(groups[0]),
    source: "local-ai",
  });
  assert.equal(controller.getName(groups[3]), null);
  assert.equal(changes[0].suggestionId, "g0");
});

test("evidence identity includes every relevant field but not displayed member ordering", () => {
  const original = proposal(),
    key = evidenceKeyFor(original);
  assert.equal(
    evidenceKeyFor({ ...original, tabs: [...original.tabs].reverse() }),
    key,
  );
  for (const field of ["id", "url", "title", "windowId", "groupId"]) {
    const changed = structuredClone(original);
    changed.tabs[0][field] =
      typeof changed.tabs[0][field] === "number"
        ? 99
        : changed.tabs[0][field] + "changed";
    assert.notEqual(evidenceKeyFor(changed), key, field);
  }
  for (const field of ["reason", "signal", "proposedName"])
    assert.notEqual(
      evidenceKeyFor({ ...original, [field]: original[field] + "changed" }),
      key,
    );
});

test("changed evidence rejects old automatic results and generates once for the new evidence", async () => {
  const oldResponse = deferred(),
    changes = [];
  let calls = 0;
  const controller = createProactiveNames({
    onName: (result) => changes.push(result),
    generate: async () =>
      ++calls === 1 ? oldResponse.promise : "Mercury reference",
  });
  const old = proposal(),
    current = structuredClone(old);
  current.tabs[0].title += " v2";
  void controller.sync([old], enabled);
  await tick();
  const latest = controller.sync([current], enabled);
  oldResponse.resolve("Mercury work");
  await latest;
  assert.equal(controller.getName(old), null);
  assert.equal(controller.getName(current).name, "Mercury reference");
  assert.equal(changes.length, 1);
  assert.equal(changes[0].evidenceKey, evidenceKeyFor(current));
});

test("unchanged failed generation is not repeatedly attempted and manual retry uses the same cache", async () => {
  let calls = 0;
  const controller = createProactiveNames({
    generate: async () => (++calls === 1 ? null : "Mercury work"),
  });
  await controller.sync([proposal()], enabled);
  await controller.sync([proposal()], enabled);
  assert.equal(calls, 1);
  assert.equal(controller.getName(proposal()), null);
  const manual = await controller.request(proposal(), { retry: true });
  assert.equal(manual.source, "local-ai");
  assert.deepEqual(controller.getName(proposal()), manual);
  await controller.sync([proposal()], enabled);
  assert.equal(calls, 2);
});

test("fallback-equivalent and invalid outputs never receive provenance or generated cache entries", async () => {
  for (const response of [
    null,
    "  mErCuRy  ",
    "<b>Mercury</b>",
    "Mercury\nwork",
    "",
  ]) {
    const changes = [];
    let calls = 0;
    const controller = createProactiveNames({
      onName: (result) => changes.push(result),
      generate: async () => {
        calls++;
        return response;
      },
    });
    await controller.sync([proposal()], enabled);
    await controller.sync([proposal()], enabled);
    assert.equal(controller.getName(proposal()), null);
    assert.deepEqual(changes, []);
    assert.equal(calls, 1);
  }
});

test("one scheduler request runs at a time and whenIdle waits for the full current queue", async () => {
  const first = deferred(),
    second = deferred();
  let calls = 0,
    active = 0,
    maxActive = 0,
    idle = false;
  const controller = createProactiveNames({
    generate: async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      const response = calls++ === 0 ? first : second;
      const result = await response.promise;
      active--;
      return result;
    },
  });
  void controller.sync([proposal("one"), proposal("two")], enabled);
  const done = controller.whenIdle().then(() => {
    idle = true;
  });
  await tick();
  assert.equal(calls, 1);
  assert.equal(idle, false);
  first.resolve("Mercury work");
  await tick();
  assert.equal(calls, 2);
  assert.equal(idle, false);
  second.resolve("Mercury reference");
  await done;
  assert.equal(maxActive, 1);
  assert.equal(idle, true);
});

test("hidden or stopped queues discard active late output and never start remaining proposals", async () => {
  for (const hide of [true, false]) {
    const response = deferred();
    let calls = 0;
    const changes = [],
      controller = createProactiveNames({
        onName: (result) => changes.push(result),
        generate: async () => {
          calls++;
          return response.promise;
        },
      });
    void controller.sync([proposal("one"), proposal("two")], enabled);
    await tick();
    if (hide)
      void controller.sync([proposal("one"), proposal("two")], {
        ...enabled,
        visible: false,
      });
    else controller.stop();
    response.resolve("Mercury work");
    await controller.whenIdle();
    assert.equal(calls, 1);
    assert.deepEqual(changes, []);
    assert.equal(controller.getName(proposal("one")), null);
  }
});

test("manual requests deduplicate and explicit retries remain possible after the automatic budget", async () => {
  const response = deferred();
  let calls = 0;
  const controller = createProactiveNames({
    maxAutomaticAttempts: 0,
    generate: async () => {
      calls++;
      return response.promise;
    },
  });
  await controller.sync([proposal()], enabled);
  const a = controller.request(proposal(), { retry: true });
  const b = controller.request(proposal(), { retry: true });
  assert.equal(a, b);
  await tick();
  assert.equal(calls, 1);
  response.resolve("Mercury work");
  assert.equal((await a).source, "local-ai");
});

test("a newer manual selection supersedes earlier evidence and caller mutations cannot alter captured prompt data", async () => {
  const response = deferred(),
    changes = [],
    inputs = [];
  const controller = createProactiveNames({
    generate: async (tabs, context) => {
      inputs.push({ tabs, context });
      return inputs.length === 1 ? response.promise : "Mercury planning";
    },
    onName: (value) => changes.push(value),
  });
  await controller.sync([], enabled);
  const old = proposal(),
    originalTitle = old.tabs[0].title;
  const oldRequest = controller.request(old, { retry: true });
  old.tabs[0].title = "mutated outside";
  await tick();
  assert.equal(inputs[0].tabs[0].title, originalTitle);
  const selected = proposal();
  selected.tabs[1].id = 3;
  selected.tabs[1].url = "https://third.test/";
  const newRequest = controller.request(selected, { retry: true });
  response.resolve("Mercury work");
  assert.equal(await oldRequest, null);
  assert.equal((await newRequest).evidenceKey, evidenceKeyFor(selected));
  assert.equal(changes.length, 1);
});

test("erase resets generated cache and automatic budget without allowing late prior output to return", async () => {
  let calls = 0;
  const controller = createProactiveNames({
    maxAutomaticAttempts: 1,
    generate: async () => {
      calls++;
      return "Mercury work";
    },
  });
  await controller.sync([proposal()], enabled);
  controller.reset();
  assert.equal(controller.getName(proposal()), null);
  await controller.sync([proposal()], enabled);
  assert.equal(calls, 2);
});

test("private or non-web/duplicate tab identities never enter proactive generation", async () => {
  for (const patch of [
    { incognito: true },
    { url: "chrome://settings" },
    { id: 2 },
    { url: "https://user:password@site.test" },
  ]) {
    const group = proposal();
    Object.assign(group.tabs[0], patch);
    assert.equal(evidenceKeyFor(group), null);
  }
});

test("manual refinement adopts an exact pending automatic name after a review freezes automatic proposals", async () => {
  const response = deferred();
  let calls = 0;
  const controller = createProactiveNames({
    generate: async () => {
      calls++;
      return response.promise;
    },
  });
  void controller.sync([proposal()], enabled);
  await tick();
  void controller.sync([], { ...enabled, reviewProposal: proposal() });
  const manual = controller.request(proposal(), { retry: true });
  response.resolve("Mercury work");
  assert.equal((await manual).name, "Mercury work");
  assert.equal(calls, 1);
});

test("changing the reviewed selection releases stale automatic naming before its provider responds", async () => {
  const response = deferred(),
    signals = [],
    changes = [];
  const original = proposal();
  original.tabs.push({
    ...original.tabs[1],
    id: 3,
    title: "Mercury project notes",
  });
  const selected = { ...original, tabs: original.tabs.slice(0, 2) };
  const controller = createProactiveNames({
    generate: async (_tabs, _context, { signal }) => {
      signals.push(signal);
      return signals.length === 1 ? response.promise : "Mercury work";
    },
    onName: (result) => changes.push(result),
  });
  void controller.sync([original], enabled);
  await tick();
  void controller.sync([], { ...enabled, reviewProposal: original });
  assert.equal(signals[0].aborted, false);
  void controller.sync([], { ...enabled, reviewProposal: selected });
  assert.equal(signals[0].aborted, true);
  const manual = controller.request(selected, { retry: true });
  await tick();
  assert.equal(signals.length, 2);
  assert.equal((await manual).name, "Mercury work");
  response.resolve("Mercury reference");
  await controller.whenIdle();
  assert.equal(controller.getName(original), null);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].evidenceKey, evidenceKeyFor(selected));
});

test("stop resolves request and queue waits promptly while a late provider is still pending", async () => {
  const response = deferred();
  const changes = [];
  const controller = createProactiveNames({
    generate: async () => response.promise,
    onName: (result) => changes.push(result),
  });
  await controller.sync([], enabled);
  const request = controller.request(proposal(), { retry: true });
  const idle = controller.whenIdle();
  await tick();
  controller.stop();
  assert.equal(await request, null);
  await idle;
  await controller.whenIdle();
  response.resolve("Mercury work");
  await tick();
  assert.deepEqual(changes, []);
  assert.equal(controller.getName(proposal()), null);
});

test("returning visible can retry an interrupted automatic name without retrying completed failures", async () => {
  const old = deferred();
  let calls = 0;
  const controller = createProactiveNames({
    maxAutomaticAttempts: 2,
    generate: async () => (++calls === 1 ? old.promise : "Mercury work"),
  });
  void controller.sync([proposal()], enabled);
  await tick();
  await controller.sync([proposal()], { ...enabled, visible: false });
  const resumed = controller.sync([proposal()], enabled);
  old.resolve("Old discarded name");
  await resumed;
  assert.equal(calls, 2);
  assert.equal(controller.getName(proposal()).name, "Mercury work");
  await controller.sync([proposal()], enabled);
  assert.equal(calls, 2);
});

test("activity reports actual pending work and stays stopped after a cancelled provider completes late", async () => {
  const response = deferred(),
    activity = [];
  let calls = 0;
  const controller = createProactiveNames({
    generate: async () => {
      calls++;
      return response.promise;
    },
    onActivity: (status) => activity.push(status),
  });
  void controller.sync([proposal("one"), proposal("two")], enabled);
  assert.deepEqual(activity.at(-1), { running: false, queued: 2 });
  await tick();
  assert.equal(calls, 1);
  assert.deepEqual(activity.at(-1), { running: true, queued: 1 });
  controller.stop();
  const stoppedIndex = activity.length - 1;
  assert.deepEqual(activity.at(-1), { running: false, queued: 0 });
  response.resolve("Mercury work");
  await tick();
  assert.equal(calls, 1);
  assert.ok(
    activity
      .slice(stoppedIndex)
      .every((status) => !status.running && status.queued === 0),
  );
});

test("naming preference is captured for generation and invalidate earlier naming work", async () => {
  const calls = [],
    gate = deferred();
  const controller = createProactiveNames({
    generate: async (tabs, context) => {
      calls.push(context);
      return calls.length === 1 ? gate.promise : "Mercury notes";
    },
  });
  const original = { ...proposal(), namePreference: "de" };
  const first = controller.sync([original], enabled);
  await tick();
  assert.equal(calls[0].namePreference, "de");
  const changed = { ...original, namePreference: "en" };
  const second = controller.sync([changed], enabled);
  gate.resolve("Mercury work");
  await Promise.all([first, second]);
  assert.equal(controller.getName(original), null);
  assert.equal(controller.getName(changed).name, "Mercury notes");
  assert.equal(calls[1].namePreference, "en");
});
